"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  Mic,
  MicOff,
  MessageSquareText,
  Sparkles,
  Timer,
  Loader2,
  XCircle,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useLocalParticipant,
  useRoomContext,
  useConnectionState,
} from "@livekit/components-react";
import { ConnectionState, RoomEvent, Track } from "livekit-client";

// Format seconds to mm:ss
function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

// Real-Time Audio Visualizer component using Web Audio API on the LiveKit microphone track
function LiveAudioVisualizer({ stream }: { stream: MediaStream | null }) {
  const [audioLevel, setAudioLevel] = useState(0);
  const animationRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!stream) {
      setAudioLevel(0);
      return;
    }

    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioContextClass();
      
      if (audioCtx.state === "suspended") {
        audioCtx.resume();
      }

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64; // Low FFT size for volume calculation
      source.connect(analyser);

      audioContextRef.current = audioCtx;
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateVolume = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        setAudioLevel(average / 128); // Normalize to 0-1 range

        animationRef.current = requestAnimationFrame(updateVolume);
      };

      updateVolume();
    } catch (e) {
      console.error("Error setting up audio visualizer:", e);
    }

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (audioContextRef.current) audioContextRef.current.close();
    };
  }, [stream]);

  return (
    <div className="flex items-end justify-center gap-1.5 h-16 w-32">
      {[...Array(5)].map((_, i) => {
        const multiplier = [0.4, 0.7, 1.0, 0.7, 0.4][i];
        const height = Math.max(8, audioLevel * 50 * multiplier);
        return (
          <div
            key={i}
            className="w-2.5 rounded-full bg-gradient-to-t from-[var(--accent)] to-[var(--accent-2)] transition-all duration-75"
            style={{ height: `${height}px` }}
          />
        );
      })}
    </div>
  );
}

// Inner workspace component that has access to LiveKit context hooks
interface InterviewWorkspaceProps {
  sessionId: string;
  targetRole: string;
}

interface TranscriptLine {
  id: string;
  speaker: "candidate" | "interviewer";
  text: string;
}

function InterviewWorkspace({ sessionId, targetRole }: InterviewWorkspaceProps) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);
  const [simulateInterruption, setSimulateInterruption] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptLine[]>([
    {
      id: "welcome",
      speaker: "interviewer",
      text: "Establishing secure audio connection. Please say hello when you are ready.",
    },
  ]);
  const [ending, setEnding] = useState(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);

  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const connectionState = useConnectionState();
  const room = useRoomContext();

  // Sync microphone stream for visualizer
  useEffect(() => {
    if (!localParticipant) return;

    const updateStream = () => {
      const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
      if (pub?.audioTrack?.mediaStreamTrack && !pub.isMuted) {
        setMicStream(new MediaStream([pub.audioTrack.mediaStreamTrack]));
      } else {
        setMicStream(null);
      }
    };

    updateStream();

    localParticipant.on(RoomEvent.TrackPublished, updateStream);
    localParticipant.on(RoomEvent.TrackUnpublished, updateStream);
    localParticipant.on(RoomEvent.TrackMuted, updateStream);
    localParticipant.on(RoomEvent.TrackUnmuted, updateStream);

    return () => {
      localParticipant.off(RoomEvent.TrackPublished, updateStream);
      localParticipant.off(RoomEvent.TrackUnpublished, updateStream);
      localParticipant.off(RoomEvent.TrackMuted, updateStream);
      localParticipant.off(RoomEvent.TrackUnmuted, updateStream);
    };
  }, [localParticipant, isMicrophoneEnabled]);

  // Live Timer: starts when connected
  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) return;

    const timer = setInterval(() => setElapsed((prev) => prev + 1), 1000);
    return () => clearInterval(timer);
  }, [connectionState]);

  // Listen to LiveKit Data Channel messages for streaming transcripts
  useEffect(() => {
    if (!room) return;

    const handleDataReceived = (payload: Uint8Array) => {
      const decoder = new TextDecoder();
      const str = decoder.decode(payload);
      try {
        const data = JSON.parse(str);

        if (data.type === "transcript") {
          setTranscripts((prev) => {
            const id = data.id || `${data.speaker}-${Date.now()}`;
            const baseList = prev.filter((t) => t.id !== "welcome");
            const existingIndex = baseList.findIndex((t) => t.id === id);

            if (existingIndex !== -1) {
              const updated = [...baseList];
              updated[existingIndex] = {
                id,
                speaker: data.speaker,
                text: data.text,
              };
              return updated;
            } else {
              return [
                ...baseList,
                {
                  id,
                  speaker: data.speaker,
                  text: data.text,
                },
              ];
            }
          });

          // Forward finalized transcript turns to our secure server proxy API
          if (data.isFinal) {
            fetch("/api/interview/transcript", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                sessionId: sessionId,
                speaker: data.speaker,
                text: data.text,
              }),
            }).catch((err) => {
              console.error("Failed to proxy transcript log to Next.js API:", err);
            });
          }
        }
      } catch (e) {
        console.error("Error parsing LiveKit data channel message:", e);
      }
    };

    room.on(RoomEvent.DataReceived, handleDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [room, sessionId]);

  // Handle mute toggling
  const toggleMute = async () => {
    if (!localParticipant) return;
    await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
  };

  // Simulate user interruption control packet
  const handleSimulateInterruption = () => {
    const nextState = !simulateInterruption;
    setSimulateInterruption(nextState);
    if (nextState && room) {
      try {
        const encoder = new TextEncoder();
        const payload = encoder.encode(
          JSON.stringify({ type: "control", action: "interrupt" })
        );
        room.localParticipant.publishData(payload, { reliable: true });
      } catch (e) {
        console.error("Failed to send interruption packet:", e);
      }
    }
  };

  // Handle ending the interview session
  const endInterview = async () => {
    try {
      setEnding(true);

      if (room) {
        await room.disconnect();
      }

      const supabase = createClient();
      await supabase
        .from("sessions")
        .update({ status: "completed" })
        .eq("id", sessionId);

      router.push(`/interview/${sessionId}/report`);
    } catch (e) {
      console.error("Error ending interview:", e);
      router.push(`/interview/${sessionId}/report`);
    }
  };

  const getConnectionBadge = () => {
    switch (connectionState) {
      case ConnectionState.Connected:
        return (
          <span className="flex items-center gap-1.5 text-emerald-400 text-xs font-semibold uppercase tracking-wider">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-ping" />
            Connected
          </span>
        );
      case ConnectionState.Connecting:
      case ConnectionState.Reconnecting:
        return (
          <span className="flex items-center gap-1.5 text-amber-400 text-xs font-semibold uppercase tracking-wider">
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500 animate-pulse" />
            Connecting
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1.5 text-slate-400 text-xs font-semibold uppercase tracking-wider">
            <span className="h-2.5 w-2.5 rounded-full bg-slate-500" />
            Disconnected
          </span>
        );
    }
  };

  return (
    <div className="min-h-screen px-6 py-10 sm:px-10 lg:px-16">
      <div className="grid gap-8 lg:grid-cols-[1.4fr_0.6fr]">
        <section className="glass-panel rounded-[32px] p-8 sm:p-10">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-400">
                Session {sessionId || "-"}
              </p>
              <h1 className="font-display mt-3 text-3xl font-semibold text-white">
                AI Interviewer Presence
              </h1>
              <p className="mt-2 text-sm text-slate-300">
                Stay focused on voice. The AI companion is actively listening.
              </p>
            </div>
            <div className="flex items-center gap-3">
              {getConnectionBadge()}
              <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200">
                <Sparkles className="h-4 w-4 text-[var(--accent)]" />
                Behavioral focus mode
              </div>
            </div>
          </div>

          <div className="mt-10 grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="flex flex-col items-center justify-center rounded-3xl border border-white/10 bg-white/5 p-8 text-center min-h-[300px]">
              <LiveAudioVisualizer stream={micStream} />
              {micStream ? (
                <p className="mt-6 text-sm text-emerald-400">
                  Microphone is active. Speak clearly.
                </p>
              ) : (
                <p className="mt-6 text-sm text-slate-300">
                  {isMicrophoneEnabled
                    ? "Establishing audio stream..."
                    : "Microphone is currently muted."}
                </p>
              )}
            </div>

            <div className="rounded-3xl border border-white/10 bg-white/5 p-6 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                  <MessageSquareText className="h-4 w-4 text-[var(--accent-2)]" />
                  Live transcription
                </div>
                <div className="mt-4 space-y-4 max-h-[300px] overflow-y-auto pr-2 text-sm text-slate-200">
                  {transcripts.map((line) => (
                    <div
                      key={line.id}
                      className={`rounded-2xl border p-4 ${
                        line.speaker === "interviewer"
                          ? "border-[var(--accent)]/20 bg-slate-950/60"
                          : "border-white/10 bg-white/5"
                      }`}
                    >
                      <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                        {line.speaker}
                      </p>
                      <p className="mt-2 text-sm text-slate-100">{line.text}</p>
                    </div>
                  ))}
                </div>
              </div>
              <p className="mt-4 text-xs text-slate-400">
                Subtitles are visible for accessibility and review.
              </p>
            </div>
          </div>
        </section>

        <aside className="glass-panel rounded-[32px] p-8 sm:p-10">
          <div className="space-y-6">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-400">
                Target role
              </p>
              <h2 className="mt-2 text-xl font-semibold text-white">
                {targetRole}
              </h2>
            </div>

            <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
              <div className="flex items-center justify-between text-sm text-slate-200">
                <span className="flex items-center gap-2">
                  <Timer className="h-4 w-4 text-[var(--accent-2)]" />
                  Live timer
                </span>
                <span className="text-base font-semibold text-white">
                  {formatTime(elapsed)}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={toggleMute}
              className={`flex w-full items-center justify-center gap-3 rounded-2xl px-5 py-4 text-sm font-semibold transition ${
                !isMicrophoneEnabled
                  ? "bg-white/10 text-white hover:bg-white/20"
                  : "bg-[var(--accent)] text-slate-900 hover:brightness-110"
              }`}
            >
              {!isMicrophoneEnabled ? (
                <>
                  <MicOff className="h-5 w-5" />
                  Microphone muted
                </>
              ) : (
                <>
                  <Mic className="h-5 w-5" />
                  Microphone live
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleSimulateInterruption}
              className={`flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-sm font-medium transition ${
                simulateInterruption
                  ? "border-[var(--accent)] bg-white/10 text-white"
                  : "border-white/10 bg-white/5 text-slate-200"
              }`}
            >
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-[var(--accent)]" />
                Simulate interruption
              </span>
              <span className="text-xs uppercase tracking-[0.22em]">
                {simulateInterruption ? "On" : "Off"}
              </span>
            </button>

            <button
              type="button"
              onClick={endInterview}
              disabled={ending}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white px-4 py-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-200 disabled:opacity-50"
            >
              {ending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Generating Feedback...
                </>
              ) : (
                "End Interview & Generate Feedback"
              )}
            </button>

            <p className="text-xs text-slate-400">
              Ending the interview will finalize transcription and start the
              AI evaluation pipeline.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

// Main page container component
export default function InterviewPage() {
  const params = useParams<{ id: string }>();
  const sessionId = params?.id ?? "";
  
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [targetRole, setTargetRole] = useState("Product Manager");

  useEffect(() => {
    let active = true;

    async function initSession() {
      try {
        setLoading(true);
        setError(null);

        // 1. Fetch target role and details from Supabase using the browser client
        const supabase = createClient();
        const { data: sessionData, error: dbError } = await supabase
          .from("sessions")
          .select("target_role, status")
          .eq("id", sessionId)
          .single();

        if (dbError) {
          throw new Error("Unable to retrieve session data. It may not exist.");
        }

        if (active && sessionData?.target_role) {
          setTargetRole(sessionData.target_role);
        }

        // 2. Fetch LiveKit Connection Token
        const tokenRes = await fetch(`/api/livekit/token?room=${sessionId}`);
        if (!tokenRes.ok) {
          const errData = await tokenRes.json();
          throw new Error(errData.error || "Failed to fetch connection token");
        }
        const { token } = await tokenRes.json();

        if (!active) return;
        setToken(token);

        // 3. Only trigger the Modal agent if the session hasn't been started yet.
        // Guard against duplicate spawns from page refresh or React StrictMode double-invoke.
        if (sessionData?.status === "configured") {
          // Mark the session as active first to prevent re-triggering on refresh.
          await supabase
            .from("sessions")
            .update({ status: "active" })
            .eq("id", sessionId);

          fetch("/api/interview/start-agent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }),
          }).catch((err) => {
            console.error("Failed to trigger Modal agent:", err);
          });
        }

      } catch (err: any) {
        console.error("Initialization error:", err);
        if (active) {
          setError(err.message || "An unexpected error occurred");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    if (sessionId) {
      initSession();
    }

    return () => {
      active = false;
    };
  }, [sessionId]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 px-6">
        <div className="glass-panel max-w-md w-full rounded-[32px] p-8 text-center flex flex-col items-center gap-6 border border-white/10 bg-white/5">
          <div className="relative flex items-center justify-center">
            <div className="absolute inset-0 rounded-full bg-[var(--accent)]/20 blur-xl animate-pulse h-16 w-16" />
            <Sparkles className="h-10 w-10 text-[var(--accent)] animate-pulse relative" />
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-white">Initializing Session</h2>
            <p className="mt-2 text-sm text-slate-400">
              Establishing WebRTC audio transport and waking up your AI companion...
            </p>
          </div>
          <div className="w-full bg-white/10 h-1.5 rounded-full overflow-hidden relative">
            <div className="bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] h-full w-2/3 rounded-full animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 px-6">
        <div className="glass-panel max-w-md w-full rounded-[32px] p-8 text-center flex flex-col items-center gap-6 border border-white/10 bg-white/5">
          <div className="rounded-full bg-red-500/10 p-4 border border-red-500/20">
            <XCircle className="h-10 w-10 text-red-500" />
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-white">Connection Failed</h2>
            <p className="mt-2 text-sm text-slate-400">{error}</p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="w-full bg-white text-slate-950 font-semibold py-3 px-5 rounded-2xl hover:bg-slate-200 transition"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <LiveKitRoom
      video={false}
      audio={true}
      token={token ?? undefined}
      serverUrl={process.env.NEXT_PUBLIC_LIVEKIT_URL}
      connect={true}
      className="min-h-screen"
    >
      <RoomAudioRenderer />
      <InterviewWorkspace sessionId={sessionId} targetRole={targetRole} />
    </LiveKitRoom>
  );
}
