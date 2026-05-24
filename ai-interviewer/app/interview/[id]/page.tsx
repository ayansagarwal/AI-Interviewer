"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Mic,
  MicOff,
  MessageSquareText,
  Sparkles,
  Timer,
} from "lucide-react";

const transcriptSeed = [
  {
    speaker: "interviewer",
    text: "Tell me about a time you had to influence a cross-functional team without direct authority.",
  },
  {
    speaker: "candidate",
    text: "I led a product launch where engineering, design, and sales had competing timelines. I set up a shared plan and weekly checkpoints to keep us aligned.",
  },
  {
    speaker: "interviewer",
    text: "What was the impact of that approach on the final launch outcome?",
  },
];

function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export default function InterviewPage({ params }: { params: { id: string } }) {
  const [elapsed, setElapsed] = useState(0);
  const [muted, setMuted] = useState(false);
  const [simulateInterruption, setSimulateInterruption] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((prev) => prev + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="min-h-screen px-6 py-10 sm:px-10 lg:px-16">
      <div className="grid gap-8 lg:grid-cols-[1.4fr_0.6fr]">
        <section className="glass-panel rounded-[32px] p-8 sm:p-10">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-400">
                Session {params.id}
              </p>
              <h1 className="font-display mt-3 text-3xl font-semibold text-white">
                AI Interviewer Presence
              </h1>
              <p className="mt-2 text-sm text-slate-300">
                Stay focused on voice. The AI companion is actively listening.
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200">
              <Sparkles className="h-4 w-4 text-[var(--accent)]" />
              Behavioral focus mode
            </div>
          </div>

          <div className="mt-10 grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="flex flex-col items-center justify-center rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
              <div className="wave">
                <span className="wave-bar" />
                <span className="wave-bar" />
                <span className="wave-bar" />
                <span className="wave-bar" />
                <span className="wave-bar" />
              </div>
              <p className="mt-6 text-sm text-slate-300">
                Listening for STAR cues and leadership signals.
              </p>
            </div>

            <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                <MessageSquareText className="h-4 w-4 text-[var(--accent-2)]" />
                Live transcription
              </div>
              <div className="mt-4 space-y-4 text-sm text-slate-200">
                {transcriptSeed.map((line, index) => (
                  <div
                    key={`${line.speaker}-${index}`}
                    className="rounded-2xl border border-white/10 bg-slate-950/40 p-4"
                  >
                    <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                      {line.speaker}
                    </p>
                    <p className="mt-2 text-sm text-slate-100">
                      {line.text}
                    </p>
                  </div>
                ))}
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
                Product Manager
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
              onClick={() => setMuted((prev) => !prev)}
              className={`flex w-full items-center justify-center gap-3 rounded-2xl px-5 py-4 text-sm font-semibold transition ${
                muted
                  ? "bg-white/10 text-white"
                  : "bg-[var(--accent)] text-slate-900"
              }`}
            >
              {muted ? (
                <MicOff className="h-5 w-5" />
              ) : (
                <Mic className="h-5 w-5" />
              )}
              {muted ? "Microphone muted" : "Microphone live"}
            </button>

            <button
              type="button"
              onClick={() => setSimulateInterruption((prev) => !prev)}
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
              className="flex w-full items-center justify-center rounded-2xl border border-white/10 bg-white px-4 py-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-200"
            >
              End Interview & Generate Feedback
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
