import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col px-6 py-14 sm:px-10 lg:px-16">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-sm uppercase tracking-[0.32em] text-slate-400">
          <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />
          AI Interview Prep Studio
        </div>
        <Link
          href="/dashboard"
          className="rounded-full border border-white/10 px-4 py-2 text-sm font-medium text-white/80 transition hover:border-white/30 hover:text-white"
        >
          View Dashboard
        </Link>
      </header>

      <main className="mt-16 grid gap-12 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="glass-panel rounded-[28px] p-10 sm:p-12">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold uppercase tracking-[0.28em] text-slate-200">
            <Sparkles className="h-4 w-4 text-[var(--accent)]" />
            AI interview prep, starting with behavioral
          </div>
          <h1 className="font-display mt-6 text-4xl font-semibold leading-tight text-white sm:text-5xl">
            Prepare for any interview format with a focus on what matters most.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-slate-300">
            Today we deliver immersive behavioral mock interviews, STAR alignment,
            and clear AI feedback. Soon, you will also be able to practice
            algorithmic and system design interviews in the same workspace.
          </p>
          <div className="mt-10 flex flex-wrap gap-4">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-6 py-3 text-sm font-semibold text-slate-900 transition hover:brightness-110"
            >
              Open session history
              <ArrowRight className="h-4 w-4" />
            </Link>
            <div className="rounded-full border border-white/10 px-6 py-3 text-sm text-slate-300">
              Voice-first feedback. Behavioral interviews only for now.
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="glass-panel rounded-[24px] p-8">
            <h2 className="text-lg font-semibold text-white">
              Behavioral depth now, broader prep ahead.
            </h2>
            <ul className="mt-4 space-y-3 text-sm text-slate-300">
              <li>Guided STAR method evaluation for every response.</li>
              <li>Leadership principle scoring and communication clarity.</li>
              <li>Live transcript + interruption simulation.</li>
              <li>Algorithmic and system design tracks in progress.</li>
            </ul>
          </div>
          <div className="glass-panel rounded-[24px] p-8">
            <h3 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-400">
              Next session checklist
            </h3>
            <div className="mt-4 space-y-4 text-sm text-slate-200">
              <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                <span>Target role definition</span>
                <span className="text-[var(--accent)]">Required</span>
              </div>
              <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                <span>Job description context</span>
                <span className="text-slate-400">Optional</span>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
