import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText, type ModelMessage } from "ai";
import { hasMedia } from "./types";
import type {
  ChatMessage,
  Citation,
  EmbedParams,
  EmbedResult,
  LLMChunk,
  LLMClient,
  StreamChatParams,
} from "./types";

export type PdfEngine = "pdf-text" | "mistral-ocr" | "native";

/** PDF_ENGINE env (pdf-text | mistral-ocr | native); defaults to the free pdf-text. */
export function pdfEngine(): PdfEngine {
  const v = process.env.PDF_ENGINE?.trim().toLowerCase();
  return v === "mistral-ocr" || v === "native" ? v : "pdf-text";
}

/** Maps council messages to AI SDK messages (image / file parts for user messages). */
export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (typeof m.content === "string") return { role: m.role, content: m.content } as ModelMessage;
    if (m.role !== "user") {
      const text = m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      return { role: m.role, content: text } as ModelMessage;
    }
    return {
      role: "user",
      content: m.content.map((p) =>
        p.type === "text"
          ? { type: "text" as const, text: p.text }
          : p.type === "image"
            ? { type: "image" as const, image: p.data, mediaType: p.mediaType }
            : {
                type: "file" as const,
                data: p.data,
                mediaType: p.mediaType,
                filename: p.filename,
              },
      ),
    };
  });
}

/** Maps system messages to model instructions, keeping only conversation messages in messages. */
export function toModelPrompt(messages: ChatMessage[]) {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    )
    .filter(Boolean)
    .join("\n\n");
  return {
    ...(instructions ? { instructions } : {}),
    messages: toModelMessages(messages.filter((message) => message.role !== "system")),
  };
}

/** OpenRouter plugins for a request (web search and/or PDF file parser). */
export function buildPlugins(params: Pick<StreamChatParams, "messages" | "webSearch">) {
  const plugins: Array<
    { id: "web"; max_results: number } | { id: "file-parser"; pdf: { engine: PdfEngine } }
  > = [];
  if (params.webSearch) plugins.push({ id: "web", max_results: params.webSearch.maxResults });
  const hasPdf = params.messages.some(
    (m) => typeof m.content !== "string" && m.content.some((p) => p.type === "file"),
  );
  if (hasPdf && hasMedia(params.messages)) {
    plugins.push({ id: "file-parser", pdf: { engine: pdfEngine() } });
  }
  return plugins;
}

export interface OpenRouterClientOptions {
  /** Defaults to process.env.OPENROUTER_API_KEY. Server-side only. */
  apiKey?: string;
}

export class OpenRouterClient implements LLMClient {
  private readonly provider: ReturnType<typeof createOpenRouter>;
  private readonly apiKey: string;

  constructor(opts: OpenRouterClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
    this.apiKey = apiKey;
    this.provider = createOpenRouter({ apiKey });
  }

  /** POST /api/v1/embeddings (OpenAI-compatible). */
  async embed({ texts, model, signal }: EmbedParams): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], tokens: 0, costUsd: 0 };
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
      signal,
    });
    if (!res.ok) throw new Error(`Embeddings request failed: HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: Array<{ index?: number; embedding?: number[] }>;
      usage?: { prompt_tokens?: number; total_tokens?: number; cost?: number };
    };
    const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== texts.length || data.some((d) => !Array.isArray(d.embedding))) {
      throw new Error("Embeddings response malformed");
    }
    return {
      vectors: data.map((d) => d.embedding as number[]),
      tokens: json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0,
      costUsd: json.usage?.cost ?? 0,
    };
  }

  async *streamChat(params: StreamChatParams): AsyncIterable<LLMChunk> {
    const { messages, models, maxTokens, reasoning, signal, webSearch, jsonMode } = params;
    if (models.length === 0) throw new Error("streamChat requires at least one model");
    const [primary, ...fallbacks] = models;

    const plugins = buildPlugins({ messages, webSearch });
    const model = this.provider.chat(primary, {
      usage: { include: true },
      ...(fallbacks.length > 0 ? { models: [primary, ...fallbacks] } : {}),
      ...(plugins.length > 0 ? { plugins } : {}),
      ...(jsonMode ? { extraBody: { response_format: { type: "json_object" } } } : {}),
      ...(reasoning
        ? {
            reasoning:
              "effort" in reasoning
                ? { effort: reasoning.effort }
                : { max_tokens: reasoning.maxTokens },
          }
        : {}),
    });

    const prompt = toModelPrompt(messages);
    const result = streamText({
      model,
      ...prompt,
      maxOutputTokens: maxTokens,
      abortSignal: signal,
      onError: () => {},
    });

    const citations: Citation[] = [];
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        yield { type: "text", delta: part.text };
      } else if (part.type === "reasoning-delta") {
        yield { type: "reasoning", delta: part.text };
      } else if (part.type === "source") {
        if (part.sourceType === "url" && !citations.some((c) => c.url === part.url)) {
          citations.push({ url: part.url, ...(part.title ? { title: part.title } : {}) });
        }
      } else if (part.type === "error") {
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }

    const [response, providerMetadata, usage, finishReason] = await Promise.all([
      result.response,
      result.providerMetadata,
      result.usage,
      result.finishReason,
    ]);
    const modelUsed = response.modelId || primary;
    const or = providerMetadata?.openrouter as
      { usage?: { promptTokens?: number; completionTokens?: number; cost?: number } } | undefined;

    if (citations.length > 0) yield { type: "citations", citations };
    if (modelUsed !== primary) {
      yield { type: "fallback", primary, modelUsed };
    }
    yield {
      type: "usage",
      usage: {
        promptTokens: or?.usage?.promptTokens ?? usage.inputTokens ?? 0,
        completionTokens: or?.usage?.completionTokens ?? usage.outputTokens ?? 0,
        costUsd: or?.usage?.cost ?? 0,
        modelUsed,
        finishReason,
      },
    };
  }
}
