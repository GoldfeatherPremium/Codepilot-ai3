# OAuth & Authentication Audit Report

**Date:** 2026-06-13  
**Risk Level:** LOW  
**Status:** ✅ No issues found requiring fixes

---

## Localhost / Hardcoded URL Audit

**Search performed across all `src/**/*.{ts,tsx}` files for:**
- `localhost`
- `127.0.0.1`
- Hardcoded callback URLs
- Hardcoded OAuth URLs
- Hardcoded Site URLs

**Result: ZERO hardcoded localhost or production URL references found.**

All OAuth flows use `window.location.origin` dynamically:

```typescript
// src/app/login/page.tsx
redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
```

```typescript
// src/app/(dashboard)/settings/page.tsx (GitHub reconnect)
redirectTo: `${window.location.origin}/auth/callback?next=/settings`,
```

This is the correct pattern — the redirect URL is always the actual host, works identically in dev, staging, and production.

---

## Centralized URL Config Added

**New file:** `src/lib/site-url.ts`

Provides `getSiteUrl()` and `getAbsoluteUrl(path)` for server-side use:
- Priority: `NEXT_PUBLIC_SITE_URL` → `NEXT_PUBLIC_APP_URL` → `window.location.origin` → `localhost:3000`
- Browser always uses `window.location.origin` (correct for OAuth)

---

## Authentication Flow Audit

### Login Flow
| Step | Status | Notes |
|------|--------|-------|
| GitHub OAuth trigger | ✅ PASS | `signInWithOAuth({ provider: "github", options: { scopes: "read:user user:email repo" } })` |
| Google OAuth trigger | ✅ PASS | `signInWithOAuth({ provider: "google" })` |
| Redirect URL | ✅ PASS | Uses `window.location.origin` — never hardcoded |
| Loading state | ✅ PASS | `pending` state disables buttons during OAuth redirect |
| Error display | ✅ PASS | Errors displayed below buttons |

### OAuth Callback (`/auth/callback`)
| Step | Status | Notes |
|------|--------|-------|
| Code validation | ✅ PASS | Returns 400 redirect if `code` param missing |
| Code exchange | ✅ PASS | `supabase.auth.exchangeCodeForSession(code)` |
| Error handling | ✅ PASS | Redirects to `/login?error=<message>` on failure |
| Open redirect protection | ✅ PASS | `safeNext` validates path starts with `/` and not `//` |
| GitHub token capture | ✅ PASS | `provider_token` encrypted and stored server-side |
| Token storage failure | ✅ PASS | Non-fatal — user can reconnect from Settings |
| Final redirect | ✅ PASS | Redirects to `safeNext` (default: `/dashboard`) |

### Middleware (Session Guard)
| Check | Status | Notes |
|-------|--------|-------|
| Session validation | ✅ PASS | `supabase.auth.getUser()` on every request |
| Public path whitelist | ✅ PASS | `/`, `/login`, `/auth/callback` are public |
| Unauthenticated redirect | ✅ PASS | → `/login?next=<original-path>` |
| Already-logged-in redirect | ✅ PASS | `/login` → `/dashboard` |
| Static asset exclusion | ✅ PASS | Matcher excludes `_next/static`, `_next/image`, etc. |

### Logout
| Step | Status | Notes |
|------|--------|-------|
| Sign out | ✅ PASS | `createClient().auth.signOut()` then `router.push("/login")` |
| Router refresh | ✅ PASS | `router.refresh()` clears server cache |

### Session Refresh
| Step | Status | Notes |
|------|--------|-------|
| Server-side refresh | ✅ PASS | Middleware calls `supabase.auth.getUser()` which auto-refreshes tokens |
| Cookie persistence | ✅ PASS | `setAll` callback correctly propagates cookies to response |

### GitHub Connect (Settings page)
| Step | Status | Notes |
|------|--------|-------|
| Connect button | ✅ PASS | Triggers GitHub OAuth with `repo` scope |
| Reconnect button | ✅ PASS | Same flow, overwrites stored token |
| Token encryption | ✅ PASS | AES-256-GCM in `github-sync` edge function |
| Token display | ✅ PASS | Never returned to client — only `github_username` shown |

---

## Supabase OAuth Provider Requirements

These must be configured in the Supabase Dashboard → Auth → Providers:

### GitHub OAuth App
- **Client ID:** Your GitHub OAuth App ID
- **Client Secret:** Your GitHub OAuth App Secret  
- **Callback URL:** `https://<your-supabase-project>.supabase.co/auth/v1/callback`
- **GitHub App settings → Callback URL:** Same as above

### Google OAuth (Optional)
- **Client ID:** Google Cloud Console OAuth 2.0 Client ID
- **Client Secret:** Google Cloud Console OAuth 2.0 Client Secret
- **Authorized redirect URIs:** `https://<your-supabase-project>.supabase.co/auth/v1/callback`

---

## Environment Variables for OAuth

| Variable | Required | Purpose |
|----------|----------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Supabase anon key |
| `NEXT_PUBLIC_SITE_URL` | Optional | Canonical app URL (server-side use) |
| `NEXT_PUBLIC_APP_URL` | Optional | Alias for SITE_URL |

**No OAuth credentials are stored in the Next.js app** — they live entirely in Supabase.

---

## Findings Summary

| Finding | Severity | Status |
|---------|----------|--------|
| Hardcoded localhost in OAuth redirects | None found | ✅ N/A |
| Open redirect vulnerability | None found | ✅ Fixed (existing guard) |
| OAuth token exposure to client | None found | ✅ N/A |
| Missing `next` param validation | None found | ✅ N/A |
| Session not refreshed in middleware | None found | ✅ N/A |

**Overall: OAuth and authentication implementation is production-ready.**
