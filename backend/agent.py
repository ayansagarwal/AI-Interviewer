import os
import json
import logging
import asyncio
import io
import wave
import struct
import numpy as np
import aiohttp
from typing import Optional
from livekit import api, rtc
from livekit.agents import stt, tts, llm
from livekit.agents.pipeline import VoicePipelineAgent
from livekit.rtc import AudioFrame
from livekit.agents.utils import AudioBuffer, merge_frames
from livekit.plugins import openai, silero

logger = logging.getLogger("voice-agent")


# --- Groq Whisper STT (Cloud API — fast, free) ---
class GroqWhisperSTT(stt.STT):
    def __init__(self):
        super().__init__(
            capabilities=stt.STTCapabilities(streaming=False, interim_results=False)
        )
        self._api_key = os.environ.get("LLM_API_KEY", "")  # Reuses the same Groq key
        self._url = "https://api.groq.com/openai/v1/audio/transcriptions"

    async def _recognize_impl(
        self,
        buffer: AudioBuffer,
        *,
        language: str | None = None,
    ) -> stt.SpeechEvent:
        merged = merge_frames(buffer)
        audio_bytes = merged.data.tobytes()

        # Convert to WAV in memory (Groq expects a file upload)
        wav_buffer = io.BytesIO()
        with wave.open(wav_buffer, "wb") as wf:
            wf.setnchannels(merged.num_channels)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(merged.sample_rate)
            wf.writeframes(audio_bytes)
        wav_buffer.seek(0)

        # Call Groq Whisper API
        form = aiohttp.FormData()
        form.add_field("file", wav_buffer, filename="audio.wav", content_type="audio/wav")
        form.add_field("model", "whisper-large-v3")
        form.add_field("language", "en")
        form.add_field("response_format", "json")

        async with aiohttp.ClientSession() as session:
            async with session.post(
                self._url,
                data=form,
                headers={"Authorization": f"Bearer {self._api_key}"},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    logger.error(f"Groq STT error {resp.status}: {error_text}")
                    return stt.SpeechEvent(
                        type=stt.SpeechEventType.FINAL_TRANSCRIPT,
                        alternatives=[stt.SpeechData(text="", language="en")]
                    )
                result = await resp.json()

        text = result.get("text", "").strip()
        return stt.SpeechEvent(
            type=stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives=[stt.SpeechData(text=text, language="en")]
        )


# --- Deepgram Aura TTS (Cloud API — streaming, low latency) ---
class DeepgramTTS(tts.TTS):
    def __init__(self, voice: str = "aura-asteria-en"):
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=24000,
            num_channels=1,
        )
        self._api_key = os.environ.get("DEEPGRAM_API_KEY", "")
        self._voice = voice
        self._url = f"https://api.deepgram.com/v1/speak?model={voice}&encoding=linear16&sample_rate=24000"

    def synthesize(self, text: str) -> tts.ChunkedStream:
        return DeepgramChunkedStream(
            api_key=self._api_key,
            url=self._url,
            text=text,
            tts_instance=self,
        )


class DeepgramChunkedStream(tts.ChunkedStream):
    def __init__(self, api_key: str, url: str, text: str, tts_instance: tts.TTS):
        super().__init__(tts_instance, text)
        self._api_key = api_key
        self._url = url

    async def _main_task(self) -> None:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                self._url,
                json={"text": self._input_text},
                headers={
                    "Authorization": f"Token {self._api_key}",
                    "Content-Type": "application/json",
                },
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    logger.error(f"Deepgram TTS error {resp.status}: {error_text}")
                    return

                # Read the full PCM response (linear16, 24kHz, mono)
                pcm_data = await resp.read()

        if not pcm_data:
            return

        num_samples = len(pcm_data) // 2
        frame = AudioFrame(
            data=pcm_data,
            sample_rate=24000,
            num_channels=1,
            samples_per_channel=num_samples,
        )

        self._event_ch.send_nowait(
            tts.SynthesizedAudio(
                request_id="deepgram-req",
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

This is a PRACTICE interview — your goal is to help the candidate rehearse and improve their behavioral interview skills. Be encouraging but honest. If their answer is vague or incomplete, probe gently.

SESSION FORMAT:
- Total time: 5 minutes
- You control the pacing. Aim to cover 2-3 questions depending on how detailed the candidate's answers are.
- Short, surface-level answers → ask follow-ups to draw out depth, and you'll have time for more questions.
- Long, detailed answers → fewer follow-ups needed, move to the next question sooner.
- Always leave ~30 seconds at the end for a brief closing.

YOUR CONVERSATION APPROACH:
1. Open with a brief welcome (1 sentence), then ask your first question.
2. After each answer, decide:
   - If the answer covered Situation, Task, Action, AND Result clearly → acknowledge and move to the next question.
   - If one or more STAR elements are missing or vague → ask ONE targeted follow-up (e.g. "What specifically did you do?" or "What was the measurable outcome?").
   - If the candidate is struggling or giving very short answers → rephrase or offer a gentle nudge like "Take your time — can you think of a specific example?"
3. Transition between questions naturally: "That's helpful, thank you. Let me ask you about something different..."
4. When closing, briefly thank them and mention one specific thing they did well.

TIME AWARENESS:
- You will receive system messages about time:
  - [TIME CHECK: X minutes remaining] — adjust your pacing. If 2+ minutes remain and you've only asked one question, move to the next. If under 1 minute remains, begin closing.
  - [TIME WARNING] — stop asking new questions. Wrap up naturally within 1-2 sentences.
  - [TIME UP] — deliver a single goodbye sentence immediately.
- Do NOT mention the time to the candidate. Just silently adjust your pacing.
- Never rush the candidate. If time is short, it's better to have one deep conversation than two shallow ones.

SPEAKING STYLE:
- Keep every response to 1-3 short sentences. This is voice, not text.
- Sound natural and conversational. Brief acknowledgments like "I see" or "Got it" are fine.
- Never use bullet points, numbered lists, markdown, or any written formatting.
- Never reveal you are an AI.
- Do not repeat or summarize what the candidate said — acknowledge briefly and move forward.

QUESTION SELECTION:
- Choose questions relevant to the {target_role} role: leadership, problem-solving, communication, teamwork, conflict resolution, adaptability, or decision-making under uncertainty.
- Frame questions around specific past experiences (STAR method).
- Vary topics — don't ask two questions about the same competency.
- Adapt difficulty to the candidate. If their first answer is very junior, ask proportionally scoped questions.
"""
    if job_description:
        prompt += f"""
JOB CONTEXT (use this to tailor your questions):
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

    # Instantiate cloud API models (no local GPU needed)
    stt_model = GroqWhisperSTT()
    tts_model = DeepgramTTS(voice="aura-asteria-en")  # Professional female voice
    llm_model = create_llm()
    vad_model = silero.VAD.load(
        min_silence_duration=0.8,   # Wait 800ms of silence before deciding user is done
        min_speech_duration=0.1,
    )

    # Create LLM chat context
    chat_ctx = llm.ChatContext()
    chat_ctx.append(
        role="system",
        text=get_system_prompt(target_role, job_description)
    )

    # Initialize VoicePipeline with early text broadcasting
    from livekit.agents.pipeline import AgentTranscriptionOptions

    # Track what we've already broadcast to avoid duplicates
    last_candidate_broadcast = ""

    def before_tts(agent, text_or_stream):
        """Broadcast interviewer text as soon as LLM finishes streaming (before TTS audio)."""
        if isinstance(text_or_stream, str):
            asyncio.ensure_future(
                broadcast_transcript(room, "interviewer", text_or_stream, is_final=True)
            )
            return text_or_stream
        else:
            async def stream_and_broadcast(stream):
                collected = ""
                async for chunk in stream:
                    collected += chunk
                    yield chunk
                if collected.strip():
                    await broadcast_transcript(room, "interviewer", collected.strip(), is_final=True)
            return stream_and_broadcast(text_or_stream)

    pipeline = VoicePipelineAgent(
        vad=vad_model,
        stt=stt_model,
        llm=llm_model,
        tts=tts_model,
        chat_ctx=chat_ctx,
        min_endpointing_delay=0.6,
        before_tts_cb=before_tts,
    )

    # Broadcast candidate text immediately when STT produces it (not waiting for agent to speak)
    @pipeline.on("user_speech_committed")
    def on_user_speech(msg: llm.ChatMessage):
        nonlocal last_candidate_broadcast
        content = msg.content if isinstance(msg.content, str) else (
            " ".join(p.text for p in msg.content if hasattr(p, "text"))
            if msg.content else ""
        )
        if content and content != last_candidate_broadcast:
            last_candidate_broadcast = content
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
    last_time_check = 0  # Track when we last injected a time check

    async def send_timer_event(event_type: str):
        """Broadcast a timer control event over the data channel to the frontend."""
        try:
            payload = json.dumps({"type": "timer_event", "event": event_type}).encode("utf-8")
            await room.local_participant.publish_data(payload)
        except Exception as e:
            logger.error(f"Failed to send timer event: {e}")

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

            # Inject periodic time checks every 60 seconds so the LLM can pace itself
            elapsed_minutes = int(elapsed // 60)
            if elapsed_minutes > last_time_check and remaining > 60:
                last_time_check = elapsed_minutes
                remaining_mins = int(remaining // 60)
                chat_ctx.append(
                    role="system",
                    text=f"[TIME CHECK: {remaining_mins} minutes remaining]",
                )
                logger.info(f"Injected time check: {remaining_mins} min remaining")

            # 1-minute warning
            if not warning_sent and elapsed >= (INTERVIEW_DURATION_SECONDS - 60):
                logger.info("Sending 1-minute time warning.")
                warning_sent = True
                await send_timer_event("warning")
                chat_ctx.append(
                    role="system",
                    text="[TIME WARNING] Less than 1 minute remaining. Begin your closing remarks naturally on your next response. Do not ask any new questions.",
                )

            # Hard cutoff at 5:00 elapsed
            if not interview_ended and remaining <= 0:
                logger.info("Time limit reached. Closing interview.")
                interview_ended = True
                await send_timer_event("expired")
                chat_ctx.append(
                    role="system",
                    text="[TIME UP] The interview is over. Deliver a warm 1-sentence goodbye immediately.",
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
