import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Handles the OAuth redirect from Supabase Auth.
// For GitHub sign-ins we also capture the provider access token and hand it to
// the `github-sync` edge function, which encrypts it (AES-256-GCM) and stores
// it on the user row. The token never touches client-side storage.
export async function GET(request: NextRequest) {
  const { searchParams, origin: requestOrigin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";

  // Use the configured site URL from env if available — prevents localhost leaking
  // through when running behind a reverse proxy (Nginx, Supabase redirect, etc.).
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
    requestOrigin;

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
  }

  const session = data.session;
  const isGitHub = session?.user.app_metadata?.provider === "github";

  if (isGitHub && session?.provider_token) {
    const { error: fnError } = await supabase.functions.invoke("github-sync", {
      body: {
        action: "store_token",
        providerToken: session.provider_token,
        githubUsername: session.user.user_metadata?.user_name ?? null,
      },
    });
    if (fnError) {
      const msg = fnError instanceof Error ? fnError.message : String(fnError);
      return NextResponse.redirect(
        `${origin}/settings?github_error=${encodeURIComponent(msg)}`
      );
    }
  } else if (isGitHub && !session?.provider_token) {
    return NextResponse.redirect(`${origin}/settings?github_error=no_provider_token`);
  }

  return NextResponse.redirect(`${origin}${safeNext}`);
}
