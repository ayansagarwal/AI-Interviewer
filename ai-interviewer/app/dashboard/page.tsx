import Link from "next/link";
import { Calendar, ChevronRight, Trophy } from "lucide-react";

import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("sessions")
    .select("id, target_role, created_at, evaluations (overall_score)")
    .order("created_at", { ascending: false });

  const sessions = data ?? [];

  return (
    <div className="min-h-screen px-6 py-12 sm:px-10 lg:px-16">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-slate-400">
            Behavioral history
          </p>
          <h1 className="font-display mt-3 text-3xl font-semibold text-white sm:text-4xl">
            Past interview sessions
          </h1>
          <p className="mt-3 max-w-xl text-base text-slate-300">
            Review STAR alignment, communication strength, and overall score from
            each completed interview.
          </p>
        </div>
        <div className="glass-panel rounded-full px-6 py-3 text-sm text-slate-200">
          {sessions.length} sessions logged
        </div>
      </div>

      <section className="mt-10 grid gap-4">
        {sessions.length === 0 ? (
          <div className="glass-panel rounded-3xl p-10 text-center text-slate-300">
            No behavioral sessions yet. Launch a live interview to populate the
            dashboard.
          </div>
        ) : (
          sessions.map((session) => {
            const evaluation = Array.isArray(session.evaluations)
              ? session.evaluations[0]
              : session.evaluations;
            const overallScore = evaluation?.overall_score ?? null;
            const createdAt = session.created_at
              ? new Date(session.created_at).toLocaleDateString()
              : "Unknown date";

            return (
              <Link
                key={session.id}
                href={`/interview/${session.id}/report`}
                className="glass-panel group flex flex-col gap-4 rounded-3xl p-6 transition hover:border-white/30"
              >
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                      Target role
                    </p>
                    <h2 className="mt-2 text-xl font-semibold text-white">
                      {session.target_role}
                    </h2>
                  </div>
                  <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200">
                    <Calendar className="h-4 w-4 text-[var(--accent-2)]" />
                    {createdAt}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Trophy className="h-5 w-5 text-[var(--accent)]" />
                    <span className="text-sm text-slate-200">
                      Overall score
                    </span>
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm font-semibold text-white">
                      {overallScore ?? "Pending"}
                    </span>
                  </div>
                  <span className="flex items-center gap-2 text-sm text-slate-300">
                    View report
                    <ChevronRight className="h-4 w-4 transition group-hover:translate-x-1" />
                  </span>
                </div>
              </Link>
            );
          })
        )}
      </section>
    </div>
  );
}
