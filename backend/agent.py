import os
import json
import logging
import asyncio
import numpy as np
from typing import Optional
from livekit import api, rtc
from livekit.agents import stt, tts, llm
from livekit.agents.pipeline import VoicePipelineAgent
from livekit.rtc import AudioFrame
from livekit.agents.utils import AudioBuffer, merge_frames
from livekit.plugins import openai, silero

logger = logging.getLogger("voice-agent")


# --- Custom Whisper V3 Turbo STT Wrapper (Runs locally on GPU) ---
class FasterWhisperSTT(stt.STT):
    def __init__(self, model_size_or_path: str = "turbo"):
        super().__init__(
            capabilities=stt.STTCapabilities(streaming=False, interim_results=False)
        )
        from faster_whisper import WhisperModel
        # Run STT on CPU with int8 — avoids CUDA library dependency issues.
        # The VAD (Silero/ONNX) and TTS (Kokoro/ONNX) still use the GPU.
        # Whisper 'turbo' on CPU is fast enough for non-streaming batch transcription.
        self.model = WhisperModel(model_size_or_path, device="cpu", compute_type="int8")

    async def _recognize_impl(
        self,
        buffer: AudioBuffer,
        *,
        language: str | None = None,
    ) -> stt.SpeechEvent:
        # Merge audio frames into a single contiguous frame
        merged = merge_frames(buffer)
        audio_bytes = merged.data.tobytes()
        
        # Convert PCM 16-bit to float32
        audio_np = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        
        # Transcribe audio
        loop = asyncio.get_running_loop()
        def transcribe():
            segments, info = self.model.transcribe(audio_np, beam_size=1, language="en")
            text = " ".join([segment.text for segment in segments]).strip()
            return text, info.language

        text, lang = await loop.run_in_executor(None, transcribe)
        
        return stt.SpeechEvent(
            type=stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives=[stt.SpeechData(text=text, language=lang or "en")]
        )


# --- Custom Kokoro-82M TTS Wrapper (Runs locally on GPU) ---
class KokoroTTS(tts.TTS):
    def __init__(self, model_path: str, voices_path: str, voice: str = "af_bella", speed: float = 1.0):
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=24000,
            num_channels=1,
        )
        from kokoro_onnx import Kokoro
        self.kokoro = Kokoro(model_path, voices_path)
        self.voice = voice
        self.speed = speed

    def synthesize(self, text: str) -> tts.ChunkedStream:
        return KokoroChunkedStream(
            kokoro=self.kokoro,
            text=text,
            voice=self.voice,
            speed=self.speed,
            tts_instance=self,
        )


class KokoroChunkedStream(tts.ChunkedStream):
    def __init__(self, kokoro, text: str, voice: str, speed: float, tts_instance: tts.TTS):
        super().__init__(tts_instance, text)
        self.kokoro = kokoro
        self.voice = voice
        self.speed = speed

    async def _main_task(self) -> None:
        loop = asyncio.get_running_loop()
        def generate():
            return self.kokoro.create(self._input_text, voice=self.voice, speed=self.speed)

        samples, sample_rate = await loop.run_in_executor(None, generate)

        # Convert float32 samples to 16-bit PCM
        pcm_data = (samples * 32767).astype(np.int16).tobytes()

        # Kokoro outputs at 24000Hz — LiveKit supports 24kHz natively
        num_samples = len(pcm_data) // 2
        frame = AudioFrame(
            data=pcm_data,
            sample_rate=24000,
            num_channels=1,
            samples_per_channel=num_samples,
        )

        self._event_ch.send_nowait(
            tts.SynthesizedAudio(
                request_id="kokoro-req",
                frame=frame,
                is_final=True,
            )
        )


# --- LLM Client Builder (Qwen 2.5 OpenAI-compatible Interface) ---
def create_llm():
    # Fetch environment variables, default to OpenAI GPT-4o-mini if not configured
    base_url = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
    api_key = os.getenv("LLM_API_KEY", os.getenv("OPENAI_API_KEY", "mock-key"))
    model = os.getenv("LLM_MODEL", "gpt-4o-mini")

    return openai.LLM(
        base_url=base_url,
        api_key=api_key,
        model=model
    )


INTERVIEW_DURATION_SECONDS = 5 * 60  # 5-minute interview limit


# --- Helper to generate the behavioral interviewing system prompt ---
def get_system_prompt(target_role: str, job_description: Optional[str] = None) -> str:
    prompt = f"""You are an AI interviewer conducting a practice behavioral interview for the role of: {target_role}.

This is a PRACTICE interview — your goal is to help the candidate rehearse and improve their behavioral interview skills. Be encouraging but honest. If their answer is vague, help them structure it better.

SESSION FORMAT:
- Total time: 5 minutes
- Structure: 2 behavioral questions, each with up to 1 follow-up probe
- Pacing: ~2 minutes per question (including their answer and your follow-up), then ~1 minute for closing

YOUR CONVERSATION FLOW:
1. Open with a brief, warm welcome (1 sentence). Immediately ask Question 1.
2. Listen to their answer. If they gave a complete STAR response (Situation, Task, Action, Result), acknowledge it and move to Question 2. If they missed an element, ask ONE short follow-up to draw it out (e.g. "What was the specific outcome?" or "Can you walk me through exactly what you did?").
3. After Question 1 is complete, transition naturally to Question 2 with a phrase like "Great, let's move to the next one."
4. Repeat the same pattern for Question 2.
5. After both questions, deliver a brief closing: thank them, mention one thing they did well, and wish them luck.

TIME MANAGEMENT:
- You will receive time warnings injected as system messages.
- If you receive a [TIME WARNING], immediately wrap up whatever thread you're on. Do not start a new question. Move directly to your closing remarks.
- If you receive [TIME UP], deliver a 1-sentence goodbye immediately. Do not continue the interview.
- If a candidate gives a very long answer (more than ~45 seconds), do not ask a follow-up — just acknowledge and move on to save time.

SPEAKING STYLE:
- Keep every response to 1-3 short sentences. This is a voice conversation, not a written interview.
- Sound natural and conversational. Use filler phrases like "That's great" or "I see" sparingly but naturally.
- Never use bullet points, numbered lists, markdown, or any written formatting.
- Never reveal you are an AI. Respond as a human interviewer would.
- Do not repeat or summarize what the candidate just said back to them — that wastes time. Instead, acknowledge briefly and move forward.

QUESTION SELECTION:
- Choose questions that assess behavioral qualities relevant to the {target_role} role: leadership, problem-solving, communication, teamwork, conflict resolution, or adaptability.
- Frame questions using the STAR method implicitly (ask about a specific time/situation).
- Vary the topics — don't ask two questions about the same competency.
"""
    if job_description:
        prompt += f"""
JOB CONTEXT (use this to tailor your questions to what matters for this specific role):
{job_description}
"""
    return prompt


# --- LiveKit Data Channel Broadcast Helper ---
async def broadcast_transcript(room: rtc.Room, speaker: str, text: str, segment_id: Optional[str] = None, is_final: bool = False):
    if not room.local_participant:
        return
        
    if segment_id is None:
        segment_id = f"{speaker}-{int(asyncio.get_running_loop().time() * 1000)}"
        
    try:
        payload = json.dumps({
            "type": "transcript",
            "id": segment_id,
            "speaker": speaker,
            "text": text,
            "isFinal": is_final
        }).encode("utf-8")
        
        # Broadcast reliably to all other participants
        await room.local_participant.publish_data(payload)
    except Exception as e:
        logger.error(f"Failed to publish data channel transcript: {e}")


# --- Core WebRTC Event Loop ---
async def start_agent_session(room_name: str, token: str, target_role: str, job_description: Optional[str]):
    logger.info(f"Connecting to room: {room_name}")
    room = rtc.Room()
    livekit_url = os.environ.get("LIVEKIT_URL")
    if not livekit_url:
        raise RuntimeError("LIVEKIT_URL environment variable is not set in livekit-secrets")
    await room.connect(livekit_url, token)
    logger.info(f"Connected to room: {room_name}")

    # Instantiate local GPU and API models
    stt_model = FasterWhisperSTT("small")   # 'small' is 4x faster than 'turbo' on CPU with acceptable accuracy
    tts_model = KokoroTTS(
        model_path="/root/models/kokoro-v0_19.onnx",
        voices_path="/root/models/voices.json",
        speed=1.3,   # Faster speech synthesis — reduces TTS generation time
    )
    llm_model = create_llm()
    vad_model = silero.VAD.load(
        min_silence_duration=0.8,   # Wait 800ms of silence before deciding user is done (prevents cutting off mid-thought)
        min_speech_duration=0.1,
    )

    # Create LLM chat context
    chat_ctx = llm.ChatContext()
    chat_ctx.append(
        role="system",
        text=get_system_prompt(target_role, job_description)
    )

    # Initialize VoicePipeline
    pipeline = VoicePipelineAgent(
        vad=vad_model,
        stt=stt_model,
        llm=llm_model,
        tts=tts_model,
        chat_ctx=chat_ctx,
        min_endpointing_delay=0.6,   # Wait 600ms after VAD end-of-speech before triggering LLM (gives breathing room)
    )

    # Wire up speech committed events — register BEFORE pipeline.start()
    @pipeline.on("user_speech_committed")
    def on_user_speech(msg: llm.ChatMessage):
        content = msg.content if isinstance(msg.content, str) else (
            " ".join(p.text for p in msg.content if hasattr(p, "text"))
            if msg.content else ""
        )
        if content:
            logger.info(f"Candidate said: {content}")
            asyncio.ensure_future(broadcast_transcript(room, "candidate", content, is_final=True))

    @pipeline.on("agent_speech_committed")
    def on_agent_speech(msg: llm.ChatMessage):
        content = msg.content if isinstance(msg.content, str) else (
            " ".join(p.text for p in msg.content if hasattr(p, "text"))
            if msg.content else ""
        )
        if content:
            logger.info(f"AI Interviewer said: {content}")
            asyncio.ensure_future(broadcast_transcript(room, "interviewer", content, is_final=True))

    pipeline.start(room)
    logger.info("LiveKit VoicePipeline is running")

    # Yield to let the pipeline's internal _main_task start and publish the audio track.
    await asyncio.sleep(0)

    # Trigger opening greeting — the LLM will ask Q1 as part of its welcome.
    greeting = f"Hey, welcome to your practice interview for the {target_role} role. We have 5 minutes and I'll ask you two behavioral questions. Let's jump in. Tell me about a time you faced a significant challenge at work and how you handled it."
    await pipeline.say(greeting, allow_interruptions=True)

    session_start = asyncio.get_running_loop().time()
    warning_sent  = False
    interview_ended = False

    async def send_timer_event(event_type: str):
        """Broadcast a timer control event over the data channel to the frontend."""
        try:
            payload = json.dumps({"type": "timer_event", "event": event_type}).encode("utf-8")
            await room.local_participant.publish_data(payload)
        except Exception as e:
            logger.error(f"Failed to send timer event: {e}")

    async def inject_time_warning():
        """Inject a system message into the chat context so the LLM knows time is almost up."""
        chat_ctx.append(
            role="system",
            text="[TIME WARNING] You have approximately 1 minute remaining. Wrap up your current thread and begin your closing remarks within the next exchange.",
        )

    try:
        while True:
            await asyncio.sleep(5)

            elapsed = asyncio.get_running_loop().time() - session_start
            remaining = INTERVIEW_DURATION_SECONDS - elapsed

            # Check if candidate is still present
            non_agent_participants = [
                p for p in room.remote_participants.values()
                if not p.identity.startswith("agent-")
            ]
            if len(non_agent_participants) == 0:
                logger.info("Room is empty. Shutting down.")
                break

            # 1-minute warning at 4:00 elapsed
            if not warning_sent and elapsed >= (INTERVIEW_DURATION_SECONDS - 60):
                logger.info("Sending 1-minute time warning to agent and frontend.")
                warning_sent = True
                await send_timer_event("warning")
                await inject_time_warning()

            # Hard cutoff at 5:00 elapsed
            if not interview_ended and remaining <= 0:
                logger.info("Time limit reached. Closing interview.")
                interview_ended = True
                await send_timer_event("expired")
                # Inject a hard stop instruction so the LLM delivers a closing line
                chat_ctx.append(
                    role="system",
                    text="[TIME UP] The 5-minute interview is now over. Deliver a warm, natural 1-2 sentence closing right now. Do not ask any more questions.",
                )
                break

    except asyncio.CancelledError:
        logger.info("Session cancelled.")
    finally:
        if hasattr(pipeline, "_main_atask") and pipeline._main_atask:
            pipeline._main_atask.cancel()
            try:
                await pipeline._main_atask
            except (asyncio.CancelledError, Exception):
                pass
        await room.disconnect()
        logger.info("Successfully cleaned up WebRTC connection.")
