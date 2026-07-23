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
import { ConnectionState, ParticipantEvent, RoomEvent, Track } from "livekit-client";

// Format seconds to mm:ss
function formatTime(totalSeconds: number) {
  const clamped = Math.max(0, totalSeconds);
  const minutes = Math.floor(clamped / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (clamped % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

const INTERVIEW_DURATION = 5 * 60; // 5 minutes in seconds

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
  const [interviewStarted, setInterviewStarted] = useState(false);  // true once agent speaks
  const [timeWarning, setTimeWarning] = useState(false);   // 1-min warning
  const [timeExpired, setTimeExpired] = useState(false);   // 5-min hard stop
  const [simulateInterruption, setSimulateInterruption] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptLine[]>([
    {
      id: "welcome",
      speaker: "interviewer",
      text: "Connecting to your AI interviewer... This may take a moment on first use.",
    },
  ]);
  const [ending, setEnding] = useState(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

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

    localParticipant.on(ParticipantEvent.LocalTrackPublished, updateStream);
    localParticipant.on(ParticipantEvent.LocalTrackUnpublished, updateStream);
    localParticipant.on(ParticipantEvent.TrackMuted, updateStream);
    localParticipant.on(ParticipantEvent.TrackUnmuted, updateStream);

    return () => {
      localParticipant.off(ParticipantEvent.LocalTrackPublished, updateStream);
      localParticipant.off(ParticipantEvent.LocalTrackUnpublished, updateStream);
      localParticipant.off(ParticipantEvent.TrackMuted, updateStream);
      localParticipant.off(ParticipantEvent.TrackUnmuted, updateStream);
    };
  }, [localParticipant, isMicrophoneEnabled]);

  // Live Timer: starts when the interviewer first speaks (not on connection)
  useEffect(() => {
    if (!interviewStarted) return;

    const timer = setInterval(() => setElapsed((prev) => prev + 1), 1000);
    return () => clearInterval(timer);
  }, [interviewStarted]);

  // Auto-scroll transcript to bottom when new messages arrive
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcripts]);

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
              updated[existingIndex] = { id, speaker: data.speaker, text: data.text };
              return updated;
            }
            return [...baseList, { id, speaker: data.speaker, text: data.text }];
          });

          // Start the interview timer on first interviewer message (any, not just final)
          if (data.speaker === "interviewer") {
            setInterviewStarted(true);
          }

          if (data.isFinal) {
            fetch("/api/interview/transcript", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, speaker: data.speaker, text: data.text }),
            }).catch((err) => console.error("Failed to proxy transcript:", err));
          }
        }

        if (data.type === "timer_event") {
          if (data.event === "warning") {
            setTimeWarning(true);
          }
          if (data.event === "expired") {
            setTimeExpired(true);
            // Give the agent ~8s to deliver its closing line, then auto-end
            setTimeout(() => endInterview(), 8000);
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
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                  <MessageSquareText className="h-4 w-4 text-[var(--accent-2)]" />
                  Live transcription
                </div>
                <div className="mt-4 flex-1 space-y-3 max-h-[350px] overflow-y-auto pr-2 text-sm text-slate-200 scrollbar-thin">
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
                  <div ref={transcriptEndRef} />
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

            <div className={`rounded-3xl border p-5 transition-colors duration-500 ${
              timeExpired
                ? "border-red-500/40 bg-red-500/10"
                : timeWarning
                ? "border-amber-500/40 bg-amber-500/10"
                : "border-white/10 bg-white/5"
            }`}>
              <div className="flex items-center justify-between text-sm">
                <span className={`flex items-center gap-2 font-medium ${
                  timeExpired ? "text-red-400" : timeWarning ? "text-amber-400" : "text-slate-200"
                }`}>
                  <Timer className={`h-4 w-4 ${
                    timeExpired ? "text-red-400" : timeWarning ? "text-amber-400" : "text-[var(--accent-2)]"
                  }`} />
                  {!interviewStarted
                    ? "Waiting for interviewer..."
                    : timeExpired
                    ? "Time's up"
                    : timeWarning
                    ? "Time running out"
                    : "Time remaining"}
                </span>
                <span className={`text-base font-semibold tabular-nums ${
                  !interviewStarted ? "text-slate-400" : timeExpired ? "text-red-400" : timeWarning ? "text-amber-300" : "text-white"
                }`}>
                  {!interviewStarted ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : timeExpired ? "00:00" : formatTime(INTERVIEW_DURATION - elapsed)}
                </span>
              </div>
              {interviewStarted && connectionState === ConnectionState.Connected && (
                <div className="mt-3 w-full h-1 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-1000 ${
                      timeExpired ? "bg-red-500" : timeWarning ? "bg-amber-400" : "bg-[var(--accent)]"
                    }`}
                    style={{ width: `${Math.max(0, ((INTERVIEW_DURATION - elapsed) / INTERVIEW_DURATION) * 100)}%` }}
                  />
                </div>
              )}
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
        // Guard against duplicate spawns — update status atomically, only if still 'configured'.
        if (sessionData?.status === "configured") {
          const { error: updateError } = await supabase
            .from("sessions")
            .update({ status: "active" })
            .eq("id", sessionId)
            .eq("status", "configured"); // atomic guard — only one concurrent caller wins

          if (!updateError) {
            fetch("/api/interview/start-agent", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId }),
            }).catch((err) => {
              console.error("Failed to trigger Modal agent:", err);
            });
          }
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
      serverUrl={process.env.NEXT_PUBLIC_LIVEKIT_URL ?? ""}
      connect={true}
      className="min-h-screen"
    >
      <RoomAudioRenderer />
      <InterviewWorkspace sessionId={sessionId} targetRole={targetRole} />
    </LiveKitRoom>
  );
}
