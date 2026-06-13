import { createClient } from "npm:@supabase/supabase-js@2";

/** Service-role client: bypasses RLS. Use only inside edge functions. */
export function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

/** Resolve the calling user from the Authorization header (RLS-scoped). */
export async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  return { user, client };
}
