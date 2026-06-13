/**
 * Centralized URL config.
 *
 * Server-side:   use NEXT_PUBLIC_SITE_URL or NEXT_PUBLIC_APP_URL (identical).
 * Client-side:   falls back to window.location.origin so OAuth redirects
 *                always use the actual host, never a hardcoded value.
 *
 * Priority order:
 *   1. NEXT_PUBLIC_SITE_URL  (explicitly set in .env.production)
 *   2. NEXT_PUBLIC_APP_URL   (alias, for compatibility)
 *   3. window.location.origin (browser runtime — always correct for OAuth)
 *   4. "http://localhost:3000" (dev fallback, server-side only)
 */

export function getSiteUrl(): string {
  // Browser: always use the actual origin (OAuth redirect must match)
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  // Server / build time
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  );
}

/** Build an absolute URL from a path, e.g. getAbsoluteUrl("/auth/callback") */
export function getAbsoluteUrl(path: string): string {
  const base = getSiteUrl().replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
