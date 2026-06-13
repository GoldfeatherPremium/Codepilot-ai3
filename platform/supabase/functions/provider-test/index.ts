// ============================================================================
// provider-test — add/update/test/delete provider API keys.
// Keys are AES-256-GCM encrypted before touching Postgres; the client only
// ever sees last4 + status.
// ============================================================================
import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, requireUser } from "../_shared/supabase.ts";
import { encryptSecret, decryptSecret } from "../_shared/crypto.ts";
import { complete, type ProviderConfig } from "../_shared/providers.ts";

const TEST_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini", anthropic: "claude-haiku-4-5", gemini: "gemini-2.0-flash",
  deepseek: "deepseek-chat", openrouter: "openai/gpt-4o-mini", groq: "llama-3.3-70b-versatile",
  together: "meta-llama/Llama-3.3-70B-Instruct-Turbo", fireworks: "accounts/fireworks/models/llama-v3p3-70b-instruct",
  cohere: "command-r", mistral: "mistral-small-latest", qwen: "qwen-plus",
};

Deno.serve(async (req) => {
  const opt = handleOptions(req); if (opt) return opt;
  try {
    const { user } = await requireUser(req);
    const db = adminClient();
    const body = await req.json();

    if (body.action === "add") {
      const { provider, label, apiKey, endpointUrl, region, defaultModel, isDefault } = body;
      const { ciphertext, iv } = await encryptSecret(apiKey);
      if (isDefault) await db.from("provider_configs").update({ is_default: false }).eq("user_id", user.id);
      const { data, error } = await db.from("provider_configs").insert({
        user_id: user.id, provider, label: label || provider,
        key_ciphertext: ciphertext, key_iv: iv, key_last4: apiKey.slice(-4),
        endpoint_url: endpointUrl ?? null, region: region ?? null,
        default_model: defaultModel ?? TEST_MODELS[provider] ?? null,
        is_default: !!isDefault,
      }).select("id, provider, label, key_last4, default_model, is_default, status").single();
      if (error) throw error;
      await db.rpc("write_audit", { p_user_id: user.id, p_action: "provider_key_added", p_resource_type: "provider_config", p_resource_id: data.id, p_metadata: { provider } });
      return json(data);
    }

    if (body.action === "test") {
      const { data: pc } = await db.from("provider_configs")
        .select("*").eq("id", body.configId).eq("user_id", user.id).single();
      if (!pc) return json({ error: "Not found" }, 404);
      const cfg: ProviderConfig = {
        provider: pc.provider,
        apiKey: await decryptSecret(pc.key_ciphertext, pc.key_iv),
        model: body.model || pc.default_model || TEST_MODELS[pc.provider],
        endpointUrl: pc.endpoint_url, region: pc.region,
      };
      try {
        await complete(cfg, [{ role: "user", content: "Reply with the single word: ok" }], { maxTokens: 8 });
        await db.from("provider_configs").update({
          status: "active", last_tested_at: new Date().toISOString(), test_error: null,
        }).eq("id", pc.id);
        return json({ status: "active" });
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        await db.from("provider_configs").update({
          status: /429/.test(msg) ? "rate_limited" : "invalid",
          last_tested_at: new Date().toISOString(), test_error: msg,
        }).eq("id", pc.id);
        return json({ status: "invalid", error: msg }, 422);
      }
    }

    if (body.action === "set_default") {
      await db.from("provider_configs").update({ is_default: false }).eq("user_id", user.id);
      await db.from("provider_configs").update({ is_default: true })
        .eq("id", body.configId).eq("user_id", user.id);
      await db.from("users").update({ default_provider_config_id: body.configId }).eq("id", user.id);
      return json({ ok: true });
    }

    if (body.action === "delete") {
      await db.from("provider_configs").delete().eq("id", body.configId).eq("user_id", user.id);
      await db.rpc("write_audit", { p_user_id: user.id, p_action: "provider_key_deleted", p_resource_type: "provider_config", p_resource_id: body.configId, p_metadata: {} });
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, (e as any).status ?? 500);
  }
});
