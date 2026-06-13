# Security Audit Report

**Date:** 2026-06-13  
**Risk Level:** LOW  
**Status:** ✅ No critical vulnerabilities found

---

## Audit Scope

| Area | Status |
|------|--------|
| Secrets exposure | ✅ PASS |
| API key leaks | ✅ PASS |
| Client-side secret access | ✅ PASS |
| XSS | ✅ PASS |
| CSRF | ✅ PASS |
| Open redirects | ✅ PASS |
| Auth bypass | ✅ PASS |
| Unsafe middleware | ✅ PASS |
| Unsafe API routes | ✅ PASS |
| Weak validation | ✅ PASS |

---

## 1. Secrets Exposure

**Finding:** No hardcoded secrets, API keys, or tokens in source code.

- All sensitive values are environment variables (`process.env.*`)
- Only `NEXT_PUBLIC_*` variables are exposed to the browser — these are non-secret (Supabase URL + anon key)
- `SUPABASE_SERVICE_ROLE_KEY` is server-side only, never in `NEXT_PUBLIC_*`
- `ENCRYPTION_MASTER_KEY` is a Supabase Edge Function secret only — never in Next.js env

---

## 2. API Key Storage

Provider API keys are handled correctly:

```
User enters key → POST to edge function → AES-256-GCM encrypt → store (ciphertext + iv) in Postgres
                                                                ↓
                                                 key_last4 (4 chars) returned to client
```

- Plaintext key **never** touches Postgres
- Plaintext key **never** returned to any client
- `ENCRYPTION_MASTER_KEY` stored as Supabase secret, not in any `.env` file
- IV is randomly generated per encryption (using `crypto.getRandomValues`)

---

## 3. Client-Side Secret Access

✅ No server-only secrets accessed from client components.

Verified:
- `src/lib/supabase/client.ts` — only uses `NEXT_PUBLIC_*` vars
- All edge function invocations are via `supabase.functions.invoke()` (authenticated, not direct fetch)
- No `SUPABASE_SERVICE_ROLE_KEY` reference in any `src/` file

---

## 4. XSS Prevention

| Check | Status |
|-------|--------|
| React JSX escaping | ✅ Auto-escaped by React |
| `dangerouslySetInnerHTML` usage | ✅ Not used anywhere |
| Markdown rendering | ✅ `react-markdown` (safe by default, no raw HTML) |
| User content in code blocks | ✅ Rendered as text nodes |
| `href` with `javascript:` | ✅ Not possible via `<Link>` or validated redirects |

The only user-controlled HTML rendering is in chat messages via `react-markdown`. It does not enable raw HTML (`allowDangerousHtml` is not set).

---

## 5. CSRF Prevention

Supabase uses JWT-based authentication (Bearer tokens in Authorization headers), which is inherently CSRF-resistant. No session cookies hold privileged tokens.

The Supabase session cookies (`sb-*`) are used for auth but all state-changing operations require the JWT, which cannot be read cross-origin.

---

## 6. Open Redirects

**Auth callback** (`src/app/auth/callback/route.ts`):
```typescript
const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
```
✅ Validates that `next` is a local path only. Cannot redirect to `http://evil.com`.

**Middleware** redirect:
```typescript
url.pathname = "/login";
url.searchParams.set("next", path);
```
✅ `path` comes from `request.nextUrl.pathname` — always a local path.

---

## 7. Authentication Bypass

**Middleware coverage:**

```typescript
const PUBLIC_PATHS = ["/", "/login", "/auth/callback"];
if (!user && !PUBLIC_PATHS.includes(path)) redirect("/login?next=...");
```

✅ All dashboard routes are protected. Matcher excludes static files only.

**Dashboard layout double-check:**

```typescript
// src/app/(dashboard)/layout.tsx
const { data: { user } } = await supabase.auth.getUser();
if (!user) redirect("/login");
```

✅ Server-side re-validation in layout — even if middleware is bypassed somehow, the layout guards again.

**Admin route:**

```typescript
// src/app/(dashboard)/admin/page.tsx
const { data: profile } = await supabase.from("users").select("role").eq("id", user!.id).single();
if (profile?.role !== "admin") redirect("/dashboard");
```

✅ Role check is server-side against the database, not a client claim.

---

## 8. Edge Function Security

All 6 edge functions:
- Call `requireUser(req)` before any action
- Extract JWT from `Authorization` header (not cookie)
- Use `adminClient()` (service role) only for authorized operations
- Apply rate limiting after authentication

**`requireUser` implementation:**
```typescript
export async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const client = createClient(URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  return { user, client };
}
```

✅ JWT validated by Supabase on every request. Cannot be forged without the JWT secret.

---

## 9. GitHub Webhook Security

```typescript
// github-webhook/index.ts
const ok = await verifySignature(
  Deno.env.get("GITHUB_WEBHOOK_SECRET")!, payload, req.headers.get("x-hub-signature-256"));
if (!ok) return json({ error: "Invalid signature" }, 401);
```

✅ HMAC-SHA256 signature verified using constant-time comparison (prevents timing attacks).

---

## 10. HTTP Security Headers

Set in `next.config.ts` for all routes:

| Header | Value | Protection |
|--------|-------|------------|
| `X-Frame-Options` | `DENY` | Clickjacking |
| `X-Content-Type-Options` | `nosniff` | MIME-type sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Referrer leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | API access |

Nginx adds:
| Header | Value |
|--------|-------|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |

---

## 11. Input Validation

| Location | Validation |
|----------|-----------|
| OAuth callback `next` param | Path validation (must start with `/`, not `//`) |
| GitHub token in `store_token` | Length check (`>= 20 chars`) |
| Agent iteration limit | Server-side cap (`HARD_ITERATION_CAP = 100`) |
| Rate limits | All edge functions: `check_rate_limit` RPC |

---

## Remaining Recommendations

| Item | Priority | Notes |
|------|----------|-------|
| Add Content-Security-Policy header | Medium | Mitigates XSS further; requires careful tuning for Next.js |
| Add `SameSite=Strict` to session cookies | Low | Supabase manages cookie settings |
| Implement audit log retention policy | Low | `audit_logs` table grows unbounded |
| Add `ENCRYPTION_MASTER_KEY` rotation procedure | Medium | Currently unrotatable without re-encrypting all keys |
