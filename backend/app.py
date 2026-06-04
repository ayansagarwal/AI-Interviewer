import os
import sys
import modal

# Define the Modal App
app = modal.App("voice-agent")

# Dependencies to install inside the GPU container
pip_dependencies = [
    "livekit==0.17.6",
    "livekit-agents==0.11.3",
    "livekit-plugins-silero==0.7.3",
    "livekit-plugins-openai==0.10.2",
    "faster-whisper>=1.0.3",
    "kokoro-onnx>=0.3.0",
    "onnxruntime-gpu>=1.17.0",
    "numpy<2.0.0",
    "soundfile>=0.12.1",
    "supabase>=2.4.0",
    "python-dotenv>=1.0.1",
    "fastapi[standard]",
]


# Image build function to download and cache Whisper and Kokoro weights.
# This prevents downloading weights during cold starts, bringing spin-up latency to a minimum.
def download_models():
    print("Pre-downloading faster-whisper 'turbo' weights...")
    from faster_whisper import WhisperModel
    # Run transcription once on CPU dummy array to force download and caching
    import numpy as np
    dummy_audio = np.zeros(16000, dtype=np.float32)
    model = WhisperModel("turbo", device="cpu")
    model.transcribe(dummy_audio)

    print("Pre-downloading Kokoro-82M model weights...")
    from huggingface_hub import hf_hub_download
    os.makedirs("/root/models", exist_ok=True)
    hf_hub_download(
        repo_id="thewh1teagle/Kokoro",
        filename="kokoro-v0_19.onnx",
        local_dir="/root/models",
    )
    hf_hub_download(
        repo_id="thewh1teagle/Kokoro",
        filename="voices.json",
        local_dir="/root/models",
    )
    print("Weights successfully cached inside container image!")


# Set up the GPU container image definition.
# We mount agent.py here using add_local_file so it is available to import in the container.
container_image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "git", "curl")
    .pip_install(*pip_dependencies)
    .run_function(download_models, timeout=1200)
    .add_local_file(
        local_path=os.path.join(os.path.dirname(__file__), "agent.py"),
        remote_path="/root/agent.py"
    )
)


# --- GPU-Accelerated Voice Loop Agent Function ---
@app.function(
    image=container_image,
    gpu="t4",  # Use an NVIDIA T4 GPU (cost-efficient and low latency)
    timeout=600,  # 10 minutes max session limit
    secrets=[
        modal.Secret.from_name("livekit-secrets"),
        modal.Secret.from_name("llm-secrets"),
    ],
)
async def run_agent(room_name: str, target_role: str, job_description: str | None):
    # Add container directory to path for local file imports
    sys.path.append("/root")
    from agent import start_agent_session
    from livekit import api

    # Generate access token for the agent participant
    api_key = os.environ["LIVEKIT_API_KEY"]
    api_secret = os.environ["LIVEKIT_API_SECRET"]

    token = (
        api.AccessToken(api_key, api_secret)
        .with_identity(f"agent-{room_name}")
        .with_name("AI Interviewer")
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
            )
        )
    )

    token_jwt = token.to_jwt()

    # Launch the agent WebRTC stream handler
    await start_agent_session(room_name, token_jwt, target_role, job_description)


# --- Public Serverless Webhook Endpoint (Option B Trigger) ---
@app.function(image=container_image)
@modal.fastapi_endpoint(method="POST")
def start(data: dict, authorization: str = None):
    # Validate the shared secret to prevent unauthorized agent spawning.
    # Set MODAL_WEBHOOK_SECRET in both the Modal livekit-secrets secret and the Next.js env.
    expected_secret = os.environ.get("MODAL_WEBHOOK_SECRET")
    if expected_secret:
        token = (authorization or "").removeprefix("Bearer ").strip()
        if token != expected_secret:
            from fastapi import HTTPException
            raise HTTPException(status_code=401, detail="Unauthorized")

    room_name = data.get("room_name")
    target_role = data.get("target_role", "Product Manager")
    job_description = data.get("job_description")

    if not room_name:
        return {"status": "error", "message": "room_name (session ID) is required"}

    print(f"Triggering voice agent for room '{room_name}' (Role: {target_role})...")

    # Spawn the container in the background so this API response is instant
    run_agent.spawn(room_name, target_role, job_description)

    return {
        "status": "success",
        "message": f"Agent container spawned in background for room '{room_name}'",
    }
