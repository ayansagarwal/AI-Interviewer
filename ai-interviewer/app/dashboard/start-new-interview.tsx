"use client";

import { useState, useTransition } from "react";
import { X } from "lucide-react";

import { startNewInterview } from "./actions";

export default function StartNewInterview() {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (formData: FormData) => {
    startTransition(() => {
      startNewInterview(formData);
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center rounded-full bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-slate-900 transition hover:brightness-110"
      >
        Start new interview
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 px-4 py-6"
          role="dialog"
          aria-modal="true"
        >
          <div className="glass-panel w-full max-w-2xl rounded-[28px] p-6 sm:p-8">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-slate-400">
                  New behavioral session
                </p>
                <h2 className="mt-2 text-2xl font-semibold text-white">
                  Start a live interview
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full border border-white/10 p-2 text-slate-300 transition hover:border-white/30 hover:text-white"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form action={handleSubmit} className="mt-6 space-y-5">
              <div>
                <label className="text-sm font-medium text-slate-200">
                  Target role
                </label>
                <input
                  name="targetRole"
                  placeholder="Associate Software Engineer"
                  required
                  className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-950/40 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-[var(--accent)] focus:outline-none"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-slate-200">
                  Job description
                </label>
                <textarea
                  name="jobDescription"
                  placeholder="Paste the role description or leadership principles here..."
                  rows={6}
                  className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-950/40 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-[var(--accent)] focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-400">
                  We will use this context to tailor behavioral questions.
                </p>
                <button
                  type="submit"
                  disabled={isPending}
                  className={`inline-flex items-center justify-center rounded-full px-5 py-3 text-sm font-semibold transition ${
                    isPending
                      ? "bg-white/10 text-slate-300"
                      : "bg-white text-slate-900 hover:bg-slate-200"
                  }`}
                >
                  {isPending ? "Creating session..." : "Launch interview"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
