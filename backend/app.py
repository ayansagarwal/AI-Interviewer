import os
import sys
import modal

# Define the Modal App
app = modal.App("voice-agent")

# Dependencies — no GPU-heavy packages needed anymore (STT + TTS are cloud APIs)
pip_dependencies = [
    "livekit==0.17.6",
    "livekit-agents==0.11.3",
    "livekit-plugins-silero==0.7.3",
    "livekit-plugins-openai==0.10.7",
    "aiohttp>=3.9.0",
    "numpy>=1.24.0,<2.0.0",
    "python-dotenv>=1.0.1",
    "fastapi[standard]",
]

# Lightweight container image — no model downloads needed (everything is cloud API)
container_image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg")
    .pip_install(*pip_dependencies)
    .add_local_file(
        local_path=os.path.join(os.path.dirname(__file__), "agent.py"),
        remote_path="/root/agent.py"
    )
)


# --- CPU-only Voice Agent Function (no GPU needed) ---
@app.function(
    image=container_image,
    cpu=2.0,
    memory=2048,
    timeout=1800,  # 30 minutes max per interview
    scaledown_window=300,  # Keep container warm for 5 min after finishing
    secrets=[
        modal.Secret.from_name("livekit-secrets"),
        modal.Secret.from_name("llm-secrets"),
        modal.Secret.from_name("deepgram-secretes"),
    ],
)
async def run_agent(room_name: str, target_role: str, job_description: str | None):
    sys.path.append("/root")
    from agent import start_agent_session
    from livekit import api

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
    await start_agent_session(room_name, token_jwt, target_role, job_description)


# --- Public Serverless Webhook Endpoint ---
@app.function(image=container_image)
@modal.fastapi_endpoint(method="POST")
def start(data: dict):
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
