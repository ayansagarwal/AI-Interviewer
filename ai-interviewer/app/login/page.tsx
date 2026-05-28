"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Globe } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [isEmailLoading, setIsEmailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const redirectedFrom = searchParams.get("redirectedFrom");

  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true);
    setError(null);
    setNotice(null);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });

    if (signInError) {
      setError(signInError.message);
      setIsGoogleLoading(false);
    }
  };

  const handleEmailSignIn = async () => {
    if (!email.trim()) {
      setError("Please enter your email address.");
      return;
    }

    setIsEmailLoading(true);
    setError(null);
    setNotice(null);

    const supabase = createClient();
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });

    if (otpError) {
      setError(otpError.message);
      setIsEmailLoading(false);
      return;
    }

    setNotice("Check your inbox for a secure sign-in link.");
    setIsEmailLoading(false);
  };

  return (
    <div className="min-h-screen px-6 py-14 sm:px-10 lg:px-16">
      <div className="glass-panel mx-auto flex w-full max-w-2xl flex-col gap-6 rounded-[32px] p-8 sm:p-12">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">
            AI interview prep
          </p>
          <h1 className="font-display mt-3 text-3xl font-semibold text-white sm:text-4xl">
            Sign in to start practicing
          </h1>
          <p className="mt-4 text-sm text-slate-300">
            Use Google or your email to access behavioral interview sessions and
            performance reports.
          </p>
        </div>

        {redirectedFrom ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-xs text-slate-200">
            Please sign in to access {redirectedFrom}.
          </div>
        ) : null}

        <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
          <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">
            Email sign-in
          </label>
          <input
            type="email"
            name="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            className="mt-3 w-full rounded-2xl border border-white/10 bg-slate-950/40 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-[var(--accent)] focus:outline-none"
          />
          <Button
            type="button"
            onClick={handleEmailSignIn}
            disabled={isEmailLoading}
            className="mt-4 w-full"
          >
            {isEmailLoading ? "Sending link..." : "Email me a sign-in link"}
          </Button>
        </div>

        <div className="flex items-center gap-4 text-xs uppercase tracking-[0.3em] text-slate-500">
          <span className="h-px flex-1 bg-white/10" />
          Or
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <Button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={isGoogleLoading}
          className="w-full"
        >
          <Globe className="h-4 w-4" />
          {isGoogleLoading ? "Connecting..." : "Sign in with Google"}
        </Button>

        {error ? <p className="text-sm text-rose-200">{error}</p> : null}
        {notice ? <p className="text-sm text-emerald-200">{notice}</p> : null}
        {!error && !notice ? (
          <p className="text-xs text-slate-400">
            By continuing, you agree to secure session cookies for authentication.
          </p>
        ) : null}
      </div>
    </div>
  );
}
