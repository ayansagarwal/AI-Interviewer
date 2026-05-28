"use client";

import { useState } from "react";
import { LogOut, User } from "lucide-react";

import { createClient } from "@/lib/supabase/client";

type UserMenuProps = {
  email?: string | null;
  displayName?: string | null;
};

export default function UserMenu({ email, displayName }: UserMenuProps) {
  const [isSigningOut, setIsSigningOut] = useState(false);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  const label = displayName || email || "Signed in";

  return (
    <div className="flex items-center gap-3">
      <div className="glass-panel flex items-center gap-2 rounded-full px-4 py-2 text-xs text-slate-200">
        <User className="h-3.5 w-3.5 text-[var(--accent-2)]" />
        <span className="max-w-[180px] truncate" title={label}>
          {label}
        </span>
      </div>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={isSigningOut}
        className={`flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold transition ${
          isSigningOut
            ? "border-white/10 text-slate-400"
            : "border-white/10 text-slate-200 hover:border-white/30"
        }`}
      >
        <LogOut className="h-3.5 w-3.5" />
        {isSigningOut ? "Signing out" : "Sign out"}
      </button>
    </div>
  );
}
