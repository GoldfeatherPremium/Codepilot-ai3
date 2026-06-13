// ============================================================================
// Unified AI provider adapter.
// Normalizes 14 providers behind one interface:
//   complete(config, messages, opts) -> { text, toolCalls, usage }
// Most providers are OpenAI-wire-compatible; Anthropic, Gemini, Cohere and
// Bedrock/Vertex get dedicated adapters.
// ============================================================================

export type Provider =
  | "openai" | "anthropic" | "gemini" | "deepseek" | "openrouter" | "groq"
  | "together" | "fireworks" | "azure_openai" | "aws_bedrock" | "vertex_ai"
  | "cohere" | "mistral" | "qwen";

export interface ProviderConfig {
  provider: Provider;
  apiKey: string;
  model: string;
  endpointUrl?: string | null; // azure resource / vertex endpoint / bedrock runtime
  region?: string | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}

export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
}

// USD per 1M tokens [input, output] — used for cost tracking; periodically updated.
const PRICING: Record<string, [number, number]> = {
  "gpt-4o": [2.5, 10], "gpt-4o-mini": [0.15, 0.6], "o3-mini": [1.1, 4.4],
  "claude-sonnet-4-6": [3, 15], "claude-haiku-4-5": [0.8, 4], "claude-opus-4-8": [15, 75],
  "gemini-2.0-flash": [0.1, 0.4], "gemini-2.5-pro": [1.25, 10],
  "deepseek-chat": [0.27, 1.1], "deepseek-reasoner": [0.55, 2.19],
  "mistral-large-latest": [2, 6], "command-r-plus": [2.5, 10],
  "qwen-max": [1.6, 6.4],
};

export function estimateCost(model: string, input: number, output: number): number {
  const [pIn, pOut] = PRICING[model] ?? [1, 3];
  return (input * pIn + output * pOut) / 1_000_000;
}

const OPENAI_COMPATIBLE_BASES: Partial<Record<Provider, string>> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  mistral: "https://api.mistral.ai/v1",
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
};

export async function complete(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; temperature?: number; maxTokens?: number } = {},
): Promise<CompletionResult> {
  switch (cfg.provider) {
    case "anthropic": return anthropicComplete(cfg, messages, opts);
    case "gemini": return geminiComplete(cfg, messages, opts);
    case "vertex_ai": return geminiComplete(cfg, messages, opts, true);
    case "cohere": return cohereComplete(cfg, messages, opts);
    case "aws_bedrock": return bedrockComplete(cfg, messages, opts);
    case "azure_openai": return openaiComplete(cfg, messages, opts,
      `${cfg.endpointUrl}/openai/deployments/${cfg.model}/chat/completions?api-version=2024-10-21`,
      { "api-key": cfg.apiKey });
    default: {
      const base = OPENAI_COMPATIBLE_BASES[cfg.provider];
      if (!base) throw new Error(`Unsupported provider: ${cfg.provider}`);
      return openaiComplete(cfg, messages, opts, `${base}/chat/completions`,
        { Authorization: `Bearer ${cfg.apiKey}` });
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI wire format (OpenAI, Azure, DeepSeek, OpenRouter, Groq, Together,
// Fireworks, Mistral, Qwen)
// ---------------------------------------------------------------------------
async function openaiComplete(
  cfg: ProviderConfig, messages: ChatMessage[],
  opts: { tools?: ToolDef[]; temperature?: number; maxTokens?: number },
  url: string, authHeaders: Record<string, string>,
): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: messages.map((m) => ({
      role: m.role, content: m.content,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls?.length ? {
        tool_calls: m.tool_calls.map((t) => ({
          id: t.id, type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.arguments) },
        })),
      } : {}),
    })),
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 8192,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${cfg.provider} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const choice = data.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    toolCalls: (choice?.message?.tool_calls ?? []).map((t: any) => ({
      id: t.id, name: t.function.name,
      arguments: safeParse(t.function.arguments),
    })),
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
    stopReason: choice?.finish_reason ?? "stop",
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------
async function anthropicComplete(
  cfg: ProviderConfig, messages: ChatMessage[],
  opts: { tools?: ToolDef[]; temperature?: number; maxTokens?: number },
): Promise<CompletionResult> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages.filter((m) => m.role !== "system").map((m) => {
    if (m.role === "tool") {
      return {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }],
      };
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...m.tool_calls.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.arguments })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      system: system || undefined,
      messages: turns,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 8192,
      tools: opts.tools?.map((t) => ({
        name: t.name, description: t.description, input_schema: t.parameters,
      })),
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const toolCalls = data.content.filter((b: any) => b.type === "tool_use")
    .map((b: any) => ({ id: b.id, name: b.name, arguments: b.input }));
  return {
    text, toolCalls,
    usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
    stopReason: data.stop_reason,
  };
}

// ---------------------------------------------------------------------------
// Google Gemini / Vertex AI
// ---------------------------------------------------------------------------
async function geminiComplete(
  cfg: ProviderConfig, messages: ChatMessage[],
  opts: { tools?: ToolDef[]; temperature?: number; maxTokens?: number },
  vertex = false,
): Promise<CompletionResult> {
  const url = vertex
    ? `${cfg.endpointUrl}/v1/projects/-/locations/${cfg.region ?? "us-central1"}/publishers/google/models/${cfg.model}:generateContent`
    : `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${cfg.apiKey}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (vertex) headers.Authorization = `Bearer ${cfg.apiKey}`; // OAuth access token

  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages.filter((m) => m.role !== "system").map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: m.role === "tool"
      ? [{ functionResponse: { name: m.tool_call_id, response: { output: m.content } } }]
      : m.tool_calls?.length
        ? m.tool_calls.map((t) => ({ functionCall: { name: t.name, args: t.arguments } }))
        : [{ text: m.content }],
  }));

  const res = await fetch(url, {
    method: "POST", headers,
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      generationConfig: { temperature: opts.temperature ?? 0.2, maxOutputTokens: opts.maxTokens ?? 8192 },
      tools: opts.tools?.length
        ? [{ functionDeclarations: opts.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }]
        : undefined,
    }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return {
    text: parts.filter((p: any) => p.text).map((p: any) => p.text).join(""),
    toolCalls: parts.filter((p: any) => p.functionCall).map((p: any, i: number) => ({
      id: `${p.functionCall.name}-${i}`, name: p.functionCall.name, arguments: p.functionCall.args ?? {},
    })),
    usage: {
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
    stopReason: data.candidates?.[0]?.finishReason ?? "STOP",
  };
}

// ---------------------------------------------------------------------------
// Cohere v2
// ---------------------------------------------------------------------------
async function cohereComplete(
  cfg: ProviderConfig, messages: ChatMessage[],
  opts: { tools?: ToolDef[]; temperature?: number; maxTokens?: number },
): Promise<CompletionResult> {
  const res = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 8192,
      tools: opts.tools?.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    }),
  });
  if (!res.ok) throw new Error(`cohere ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    text: (data.message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""),
    toolCalls: (data.message?.tool_calls ?? []).map((t: any) => ({
      id: t.id, name: t.function.name, arguments: safeParse(t.function.arguments),
    })),
    usage: {
      inputTokens: data.usage?.tokens?.input_tokens ?? 0,
      outputTokens: data.usage?.tokens?.output_tokens ?? 0,
    },
    stopReason: data.finish_reason ?? "COMPLETE",
  };
}

// ---------------------------------------------------------------------------
// AWS Bedrock (Converse API via SigV4 — uses key as "accessKeyId:secretKey")
// ---------------------------------------------------------------------------
async function bedrockComplete(
  cfg: ProviderConfig, messages: ChatMessage[],
  opts: { tools?: ToolDef[]; temperature?: number; maxTokens?: number },
): Promise<CompletionResult> {
  // Production note: sign with aws4fetch. Keys are stored as "AKIA...:secret".
  const { AwsClient } = await import("npm:aws4fetch@1");
  const [accessKeyId, secretAccessKey] = cfg.apiKey.split(":");
  const aws = new AwsClient({ accessKeyId, secretAccessKey, region: cfg.region ?? "us-east-1", service: "bedrock" });
  const system = messages.filter((m) => m.role === "system").map((m) => ({ text: m.content }));
  const res = await aws.fetch(
    `https://bedrock-runtime.${cfg.region ?? "us-east-1"}.amazonaws.com/model/${cfg.model}/converse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: system.length ? system : undefined,
        messages: messages.filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: [{ text: m.content }] })),
        inferenceConfig: { temperature: opts.temperature ?? 0.2, maxTokens: opts.maxTokens ?? 8192 },
      }),
    },
  );
  if (!res.ok) throw new Error(`bedrock ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    text: data.output?.message?.content?.map((c: any) => c.text ?? "").join("") ?? "",
    toolCalls: [],
    usage: { inputTokens: data.usage?.inputTokens ?? 0, outputTokens: data.usage?.outputTokens ?? 0 },
    stopReason: data.stopReason ?? "end_turn",
  };
}

// ---------------------------------------------------------------------------
// Embeddings (OpenAI text-embedding-3-small, 1536 dims — matches schema)
// ---------------------------------------------------------------------------
export async function embed(apiKey: string, input: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: input.slice(0, 8000) }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${await res.text()}`);
  return (await res.json()).data[0].embedding;
}

function safeParse(s: unknown): Record<string, unknown> {
  if (typeof s !== "string") return (s as Record<string, unknown>) ?? {};
  try { return JSON.parse(s); } catch { return {}; }
}
