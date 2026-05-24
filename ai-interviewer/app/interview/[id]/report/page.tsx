import Link from "next/link";
import { ArrowLeft, BadgeCheck, Sparkles } from "lucide-react";

import { createClient } from "@/lib/supabase/server";

type StarFeedback = Record<string, string>;

export default async function ReportPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = await createClient();
  const { data: evaluation } = await supabase
    .from("evaluations")
    .select(
      "overall_score, star_method_feedback, communication_score, strengths, weaknesses, created_at, session: sessions (target_role)"
    )
    .eq("session_id", params.id)
    .maybeSingle();

  const starRaw = evaluation?.star_method_feedback as StarFeedback | null;
  const starData = starRaw && typeof starRaw === "object" ? starRaw : {};

  const starItems = [
    { label: "Situation", value: starData.situation },
    { label: "Task", value: starData.task },
    { label: "Action", value: starData.action },
    { label: "Result", value: starData.result },
  ];

  const strengths = (evaluation?.strengths ?? []) as string[];
  const weaknesses = (evaluation?.weaknesses ?? []) as string[];
  const sessionData = Array.isArray(evaluation?.session)
    ? evaluation?.session[0]
    : evaluation?.session;
  const targetRole = sessionData?.target_role ?? "Behavioral interview";

  return (
    <div className="min-h-screen px-6 py-12 sm:px-10 lg:px-16">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-2 text-sm text-slate-300 transition hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to dashboard
      </Link>

      <header className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">
            Performance report
          </p>
          <h1 className="font-display mt-3 text-3xl font-semibold text-white sm:text-4xl">
            {targetRole}
          </h1>
          <p className="mt-4 max-w-xl text-base text-slate-300">
            A focused view of STAR alignment, communication clarity, and
            behavioral depth from this interview session.
          </p>
        </div>
        <div className="glass-panel rounded-3xl p-6">
          <div className="flex items-center gap-3 text-sm font-semibold text-slate-200">
            <BadgeCheck className="h-5 w-5 text-[var(--accent)]" />
            Overall score
          </div>
          <p className="mt-4 text-4xl font-semibold text-white">
            {evaluation?.overall_score ?? "Pending"}
          </p>
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-300">
            <Sparkles className="h-4 w-4 text-[var(--accent-2)]" />
            Communication score: {evaluation?.communication_score ?? "Pending"}
          </div>
        </div>
      </header>

      <section className="mt-10 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="glass-panel rounded-3xl p-8">
          <h2 className="text-lg font-semibold text-white">
            STAR method alignment
          </h2>
          <div className="mt-6 space-y-4">
            {starItems.map((item) => (
              <div
                key={item.label}
                className="rounded-2xl border border-white/10 bg-white/5 p-4"
              >
                <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                  {item.label}
                </p>
                <p className="mt-2 text-sm text-slate-200">
                  {item.value ?? "No feedback captured yet."}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          <div className="glass-panel rounded-3xl p-6">
            <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-400">
              Strengths
            </h3>
            <ul className="mt-4 space-y-3 text-sm text-slate-200">
              {strengths.length === 0 ? (
                <li>No strengths captured yet.</li>
              ) : (
                strengths.map((strength) => (
                  <li key={strength}>• {strength}</li>
                ))
              )}
            </ul>
          </div>

          <div className="glass-panel rounded-3xl p-6">
            <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-400">
              Areas of improvement
            </h3>
            <ul className="mt-4 space-y-3 text-sm text-slate-200">
              {weaknesses.length === 0 ? (
                <li>No improvement areas captured yet.</li>
              ) : (
                weaknesses.map((weakness) => (
                  <li key={weakness}>• {weakness}</li>
                ))
              )}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
