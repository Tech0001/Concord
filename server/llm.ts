import { getPipeline } from "./pipeline";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface EmbedOptions {
  texts: string[];
  model?: string;
  signal?: AbortSignal;
}

export interface ProviderModel {
  id: string;
  object?: string;
  owned_by?: string;
}

// Distinct error types so callers can degrade gracefully (e.g. hide LLM-driven
// UI when the server isn't running) without try/catching every status code.
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}
export class LlmUnreachableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "LlmUnreachableError";
  }
}
export class LlmHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "LlmHttpError";
  }
}

function getLlmConfig() {
  return getPipeline().getConfig().llm;
}

function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, "") + (suffix.startsWith("/") ? suffix : "/" + suffix);
}

async function llmFetch(
  pathSuffix: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const cfg = getLlmConfig();
  if (!cfg.baseUrl) throw new LlmConfigError("LLM base URL is not configured");

  const url = joinUrl(cfg.baseUrl, pathSuffix);
  const headers = { ...buildHeaders(cfg.apiKey), ...(init.headers as Record<string, string> | undefined) };

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, signal });
  } catch (err) {
    throw new LlmUnreachableError(
      `Cannot reach LLM at ${cfg.baseUrl}: ${(err as Error).message}`,
      err,
    );
  }

  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text().catch(() => undefined); }
    throw new LlmHttpError(
      `LLM ${pathSuffix} returned ${res.status}`,
      res.status,
      body,
    );
  }
  return res;
}

export async function listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
  const res = await llmFetch("/models", { method: "GET" }, signal);
  const json = await res.json() as { data?: ProviderModel[] };
  return json.data || [];
}

export async function chat(opts: ChatOptions): Promise<string> {
  const cfg = getLlmConfig();
  const model = opts.model || cfg.chatModel;
  if (!model) throw new LlmConfigError("No chat model configured");

  const res = await llmFetch("/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      messages: opts.messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      stream: false,
    }),
  }, opts.signal);

  const json = await res.json() as {
    choices?: { message?: { content?: string } }[];
  };
  // Return the raw model output. Per-task parsing (e.g. extracting a
  // summary from inside <think> tags vs <summary> tags) happens in the
  // caller — chat() shouldn't be opinionated about what's "noise" since
  // that varies by task. summarize-video.ts has its own extractor; tag
  // suggestions parse JSON; future RAG may want the thinking visible.
  return json.choices?.[0]?.message?.content || "";
}

/**
 * Streaming variant of chat() — yields delta chunks as they arrive from
 * the LLM. Used by the RAG chat endpoint so answers paint in the UI as
 * they're generated rather than blocking until completion.
 *
 * Wire format: OpenAI-compatible SSE (`data: {...}` lines, `data: [DONE]`
 * terminator). Both oMLX and Ollama serve this format on /v1/chat/completions
 * when stream=true.
 */
export async function* chatStream(opts: ChatOptions): AsyncGenerator<string, void, void> {
  const cfg = getLlmConfig();
  const model = opts.model || cfg.chatModel;
  if (!model) throw new LlmConfigError("No chat model configured");

  const res = await llmFetch("/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      messages: opts.messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      stream: true,
    }),
  }, opts.signal);

  if (!res.body) throw new LlmUnreachableError("LLM returned no response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const obj = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const delta = obj.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // Skip malformed chunks — keepalives or partial frames.
      }
    }
  }
}

/**
 * Convert a user query into the format the embedding model expects.
 *
 * Some embedding families (Qwen3-Embedding, BGE, EmbeddingGemma) are
 * instruction-tuned: queries need a task-description prefix or the
 * resulting vectors are nearly useless for retrieval. Without this,
 * the model produces document-similarity scores for everything (so
 * "Um" matches "where is it talking about oil" almost as well as a
 * real oil mention).
 *
 * Documents (the segments stored in the index) are passed through
 * unmodified — that's the convention these models train under.
 */
export function formatEmbeddingQuery(query: string, model: string): string {
  const m = model.toLowerCase();
  if (m.includes("qwen3-embedding")) {
    return `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ${query}`;
  }
  if (m.includes("embeddinggemma")) {
    return `task: search result | query: ${query}`;
  }
  if (m.startsWith("bge-") || m.includes("bge-m3")) {
    // BGE family uses a similar instruction prefix for retrieval queries
    return `Represent this sentence for searching relevant passages: ${query}`;
  }
  return query;
}

export async function embed(opts: EmbedOptions): Promise<Float32Array[]> {
  const cfg = getLlmConfig();
  const model = opts.model || cfg.embeddingModel;
  if (!model) throw new LlmConfigError("No embedding model configured");
  if (opts.texts.length === 0) return [];

  const res = await llmFetch("/embeddings", {
    method: "POST",
    body: JSON.stringify({ model, input: opts.texts }),
  }, opts.signal);

  const json = await res.json() as {
    data?: { embedding: number[] | string }[];
  };
  return (json.data || []).map((row) => {
    if (typeof row.embedding === "string") {
      // Some servers return base64-encoded float32; oMLX/Ollama return number[].
      // Decode just in case.
      const bytes = Buffer.from(row.embedding, "base64");
      return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    }
    return new Float32Array(row.embedding);
  });
}

export interface LlmStatus {
  reachable: boolean;
  latencyMs?: number;
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  hasApiKey: boolean;
  error?: string;
  errorKind?: "config" | "unreachable" | "http";
  httpStatus?: number;
}

export async function probeStatus(timeoutMs = 3000): Promise<LlmStatus> {
  const cfg = getLlmConfig();
  const base = {
    baseUrl: cfg.baseUrl,
    chatModel: cfg.chatModel,
    embeddingModel: cfg.embeddingModel,
    hasApiKey: Boolean(cfg.apiKey),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    await listModels(controller.signal);
    return { ...base, reachable: true, latencyMs: Date.now() - start };
  } catch (err) {
    if (err instanceof LlmConfigError) {
      return { ...base, reachable: false, error: err.message, errorKind: "config" };
    }
    if (err instanceof LlmHttpError) {
      return {
        ...base,
        reachable: false,
        error: err.message,
        errorKind: "http",
        httpStatus: err.status,
      };
    }
    if (err instanceof LlmUnreachableError) {
      return { ...base, reachable: false, error: err.message, errorKind: "unreachable" };
    }
    return { ...base, reachable: false, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}
