"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Github, Loader2 } from "lucide-react";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path fill="currentColor" d="M21.35 11.1H12v2.9h5.35c-.5 2.5-2.6 3.9-5.35 3.9a6 6 0 1 1 0-12c1.5 0 2.9.55 3.95 1.45l2.15-2.15A9 9 0 1 0 12 21c5.2 0 8.85-3.65 8.85-8.8 0-.37-.04-.74-.1-1.1Z" />
    </svg>
  );
}

function LoginInner() {
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";
  const [pending, setPending] = useState<"github" | "google" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signIn(provider: "github" | "google") {
    setPending(provider);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        // `repo` scope lets CodePilot read/write repositories on the user's behalf.
        scopes: provider === "github" ? "read:user user:email repo" : undefined,
      },
    });
    if (error) {
      setError(error.message);
      setPending(null);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-sm animate-slideUp">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-phosphor font-mono text-base font-bold text-black">▸</span>
          <span className="font-semibold tracking-tight">CodePilot AI</span>
        </Link>

        <div className="rounded-xl border border-line bg-surface p-6">
          <h1 className="text-center text-base font-semibold">Sign in</h1>
          <p className="mt-1 text-center text-sm text-muted">
            GitHub sign-in is recommended — it also connects your repositories.
          </p>

          <div className="mt-6 space-y-2.5">
            <Button className="w-full" size="lg" onClick={() => signIn("github")} disabled={pending !== null}>
              {pending === "github" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
              Continue with GitHub
            </Button>
            <Button variant="outline" className="w-full" size="lg" onClick={() => signIn("google")} disabled={pending !== null}>
              {pending === "google" ? <Loader2 className="h-4 w-4 animate-spin" /> : <GoogleIcon />}
              Continue with Google
            </Button>
          </div>

          {error && <p className="mt-4 text-center text-xs text-danger">{error}</p>}
        </div>

        <p className="mt-6 text-center text-xs text-faint">
          By signing in you agree to grant the permissions you select per agent. Keys and tokens are stored encrypted.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
