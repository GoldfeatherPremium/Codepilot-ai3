// ============================================================================
// memory-embed — create/search user-authored memories with embeddings.
// actions: create | search | reembed
// ============================================================================
import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, requireUser } from "../_shared/supabase.ts";
import { decryptSecret } from "../_shared/crypto.ts";
import { embed } from "../_shared/providers.ts";

async function openaiKey(db: any, userId: string): Promise<string | null> {
  const { data } = await db.from("provider_configs")
    .select("key_ciphertext, key_iv").eq("user_id", userId)
    .eq("provider", "openai").limit(1).maybeSingle();
  return data ? await decryptSecret(data.key_ciphertext, data.key_iv) : null;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req); if (opt) return opt;
  try {
    const { user } = await requireUser(req);
    const db = adminClient();
    const body = await req.json();
    const key = await openaiKey(db, user.id);

    if (body.action === "create") {
      const { scope, category, title, content, repositoryId } = body;
      const embedding = key ? await embed(key, `${title}\n${content}`) : null;
      const { data, error } = await db.from("agent_memories").insert({
        user_id: user.id, scope, category: category ?? "custom",
        title, content, embedding,
        repository_id: scope === "repository" ? repositoryId : null,
        source: "user",
      }).select("id, scope, category, title, content, pinned, created_at").single();
      if (error) throw error;
      return json(data);
    }

    if (body.action === "search") {
      if (!key) {
        // Trigram fallback when no embedding key is configured
        const { data } = await db.from("agent_memories")
          .select("id, scope, category, title, content, pinned, created_at")
          .eq("user_id", user.id).ilike("content", `%${body.query}%`).limit(20);
        return json(data ?? []);
      }
      const vec = await embed(key, body.query);
      const { data } = await db.rpc("match_memories", {
        p_user_id: user.id, p_query_embedding: vec,
        p_scope: body.scope ?? null, p_repository_id: body.repositoryId ?? null,
        p_match_count: 20, p_min_similarity: 0.5,
      });
      return json(data ?? []);
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, (e as any).status ?? 500);
  }
});
