// ============================================================================
// github-webhook — keeps PR/branch/commit state fresh.
// Verifies X-Hub-Signature-256 (HMAC) before trusting the payload.
// ============================================================================
import { json } from "../_shared/cors.ts";
import { adminClient } from "../_shared/supabase.ts";

async function verifySignature(secret: string, payload: string, signature: string | null) {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  // constant-time compare
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  const payload = await req.text();
  const ok = await verifySignature(
    Deno.env.get("GITHUB_WEBHOOK_SECRET")!, payload, req.headers.get("x-hub-signature-256"));
  if (!ok) return json({ error: "Invalid signature" }, 401);

  const event = req.headers.get("x-github-event");
  const data = JSON.parse(payload);
  const db = adminClient();

  if (event === "pull_request") {
    const pr = data.pull_request;
    const status = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
    await db.from("pull_requests").update({
      status,
      merged_at: pr.merged_at, closed_at: pr.closed_at,
      additions: pr.additions, deletions: pr.deletions, files_changed: pr.changed_files,
    }).eq("github_pr_number", pr.number)
      .in("repository_id",
        (await db.from("repositories").select("id").eq("github_repo_id", data.repository.id)).data?.map((r: any) => r.id) ?? []);
  }

  if (event === "push") {
    const { data: repos } = await db.from("repositories").select("id").eq("github_repo_id", data.repository.id);
    for (const repo of repos ?? []) {
      const branch = data.ref.replace("refs/heads/", "");
      await db.from("repository_branches").upsert({
        repository_id: repo.id, name: branch, head_sha: data.after,
        updated_at: new Date().toISOString(),
      }, { onConflict: "repository_id,name" });
    }
  }

  return json({ ok: true });
});
