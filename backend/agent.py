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
from livekit.agents.utils import AudioBuffer
from livekit.plugins import openai, silero

logger = logging.getLogger("voice-agent")


# --- Custom Whisper V3 Turbo STT Wrapper (Runs locally on GPU) ---
class FasterWhisperSTT(stt.STT):
    def __init__(self, model_size_or_path: str = "turbo"):
        super().__init__(
            capabilities=stt.STTCapabilities(streaming=False)
        )
        from faster_whisper import WhisperModel
        # Initialize model on GPU (CUDA) in float16 precision
        self.model = WhisperModel(model_size_or_path, device="cuda", compute_type="float16")

    async def _recognize_impl(self, buffer: AudioBuffer, *, language: Optional[str] = None) -> stt.SpeechEvent:
        # Merge audio frames into a single buffer
        audio_bytes = b"".join([frame.data.tobytes() for frame in buffer.frames])
        
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
            alternatives=[stt.SpeechAlternative(text=text, language=lang)]
        )


# --- Custom Kokoro-82M TTS Wrapper (Runs locally on GPU) ---
class KokoroTTS(tts.TTS):
    def __init__(self, model_path: str, voices_path: str, voice: str = "af_bella"):
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False)
        )
        from kokoro_onnx import Kokoro
        # ONNX model runs with GPU acceleration
        self.kokoro = Kokoro(model_path, voices_path)
        self.voice = voice

    def synthesize(self, text: str) -> tts.ChunkedStream:
        return KokoroChunkedStream(self.kokoro, text, self.voice)


class KokoroChunkedStream(tts.ChunkedStream):
    def __init__(self, kokoro, text: str, voice: str):
        super().__init__()
        self.kokoro = kokoro
        self.text = text
        self.voice = voice
        self._processed = False

    async def _run(self):
        if self._processed:
            return
        self._processed = True

        loop = asyncio.get_running_loop()
        def generate():
            return self.kokoro.create(self.text, voice=self.voice, speed=1.0)
            
        samples, sample_rate = await loop.run_in_executor(None, generate)
        
        # Convert float32 samples to 16-bit PCM
        pcm_data = (samples * 32767).astype(np.int16).tobytes()
        
        # Kokoro sample rate is 24000Hz. LiveKit supports 24kHz.
        num_samples = len(pcm_data) // 2
        frame = AudioFrame(
            data=pcm_data,
            sample_rate=24000,
            num_channels=1,
            samples_per_channel=num_samples
        )
        
        self._queue.put_nowait(tts.SynthesizedAudio(
            text=self.text,
            frame=frame
        ))


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


# --- Helper to generate the behavioral interviewing system prompt ---
def get_system_prompt(target_role: str, job_description: Optional[str] = None) -> str:
    prompt = f"""You are a professional behavioral interviewer conducting a real-time behavioral voice interview for the role of: {target_role}.
"""
    if job_description:
        prompt += f"Job Description context:\n{job_description}\n"
        
    prompt += """
Guidelines for your behavior:
1. Focus on assessing behavioral qualities (leadership, communication, problem-solving, conflict resolution) using the STAR framework:
   - Situation: Context of the scenario.
   - Task: The candidate's target/goal.
   - Action: What the candidate did.
   - Result: Outcome and key learnings.
2. Ask clear, open-ended questions. Only ask one question at a time.
3. Be supportive and conversational, but maintain a professional demeanor.
4. Listen carefully to the candidate's responses. Follow up on incomplete STAR aspects (e.g., if they tell a story but forget the Result, ask "What was the final outcome of that action?").
5. Do NOT speak in long paragraphs. Keep your follow-ups and questions short (1-2 sentences) to suit a real-time voice chat.
6. Do NOT write code, provide technical exercises, or write markdown formatting tags.
7. Speak naturally. Do not reveal that you are an AI.
"""
    return prompt


# --- LiveKit Data Channel Broadcast Helper ---
async def broadcast_transcript(room: rtc.Room, speaker: str, text: str, segment_id: Optional[str] = None, is_final: bool = False):
    if not room.local_participant:
        return
        
    if segment_id is None:
        segment_id = f"{speaker}-{int(asyncio.get_event_loop().time() * 1000)}"
        
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
    await room.connect(os.environ["LIVEKIT_URL"], token)
    logger.info(f"Connected to room: {room_name}")

    # Instantiate local GPU and API models
    stt_model = FasterWhisperSTT("turbo")
    tts_model = KokoroTTS(
        model_path="/root/models/kokoro-v0_19.onnx",
        voices_path="/root/models/voices.json"
    )
    llm_model = create_llm()
    vad_model = silero.VAD.load()

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
        chat_ctx=chat_ctx
    )

    pipeline.start(room)
    logger.info("LiveKit VoicePipeline is running")

    # Wire up speech committed events
    @pipeline.on("user_speech_committed")
    def on_user_speech(msg: llm.ChatMessage):
        if msg.content:
            logger.info(f"Candidate said: {msg.content}")
            asyncio.create_task(broadcast_transcript(room, "candidate", msg.content, is_final=True))

    @pipeline.on("agent_speech_committed")
    def on_agent_speech(msg: llm.ChatMessage):
        if msg.content:
            logger.info(f"AI Interviewer said: {msg.content}")
            asyncio.create_task(broadcast_transcript(room, "interviewer", msg.content, is_final=True))

    # Trigger automatic voice greeting
    greeting = f"Hello! Welcome to your behavioral interview for the {target_role} position. Can you tell me about a time you had to solve a complex problem under a tight deadline?"
    await pipeline.say(greeting, allow_interruptions=True)
    
    # Broadcast the initial greeting
    await broadcast_transcript(room, "interviewer", greeting, is_final=True)

    # Active monitoring loop: shut down if the room becomes empty (only agent left)
    try:
        while True:
            await asyncio.sleep(5)
            non_agent_participants = [
                p for p in room.participants.values() if not p.identity.startswith("agent-")
            ]
            if len(non_agent_participants) == 0:
                logger.info("Room is empty. Disconnecting and shutting down agent container.")
                break
    except asyncio.CancelledError:
        logger.info("Session cancelled.")
    finally:
        await room.disconnect()
        logger.info("Successfully cleaned up WebRTC connection.")
