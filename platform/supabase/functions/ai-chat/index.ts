// ============================================================================
// ai-chat — SSE streaming chat for the lightweight conversation path.
// Streams tokens for OpenAI-compatible + Anthropic providers; falls back to
// a single chunk for the rest. The full agentic path lives in agent-run.
// ============================================================================
import { corsHeaders, handleOptions, json } from "../_shared/cors.ts";
import { adminClient, requireUser } from "../_shared/supabase.ts";
import { decryptSecret } from "../_shared/crypto.ts";
import { complete, type ProviderConfig } from "../_shared/providers.ts";

Deno.serve(async (req) => {
  const opt = handleOptions(req); if (opt) return opt;
  try {
    const { user } = await requireUser(req);
    const db = adminClient();
    const { configId, model, messages } = await req.json();

    const { data: allowed } = await db.rpc("check_rate_limit", {
      p_user_id: user.id, p_bucket: "chat", p_limit: 120, p_window_seconds: 3600,
    });
    if (!allowed) return json({ error: "Rate limit exceeded" }, 429);

    const { data: pc } = await db.from("provider_configs")
      .select("*").eq("id", configId).eq("user_id", user.id).single();
    if (!pc) return json({ error: "Provider not found" }, 404);

    const cfg: ProviderConfig = {
      provider: pc.provider,
      apiKey: await decryptSecret(pc.key_ciphertext, pc.key_iv),
      model: model || pc.default_model,
      endpointUrl: pc.endpoint_url, region: pc.region,
    };

    // Anthropic native streaming
    if (cfg.provider === "anthropic") {
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: cfg.model, max_tokens: 4096, stream: true,
          system: messages.find((m: any) => m.role === "system")?.content,
          messages: messages.filter((m: any) => m.role !== "system") }),
      });
      return new Response(upstream.body, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
      });
    }

    // Non-streaming fallback for everything else (uniform behavior)
    const result = await complete(cfg, messages, { maxTokens: 4096 });
    return json({ text: result.text, usage: result.usage });
  } catch (e) {
    return json({ error: (e as Error).message }, (e as any).status ?? 500);
  }
});
