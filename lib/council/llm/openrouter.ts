import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText } from "ai";
import type { Citation, LLMChunk, LLMClient, StreamChatParams } from "./types";

export interface OpenRouterClientOptions {
  /** Defaults to process.env.OPENROUTER_API_KEY. Server-side only. */
  apiKey?: string;
}

export class OpenRouterClient implements LLMClient {
  private readonly provider: ReturnType<typeof createOpenRouter>;

  constructor(opts: OpenRouterClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
    this.provider = createOpenRouter({ apiKey });
  }

  async *streamChat(params: StreamChatParams): AsyncIterable<LLMChunk> {
    const { messages, models, maxTokens, reasoning, signal, webSearch } = params;
    if (models.length === 0) throw new Error("streamChat requires at least one model");
    const [primary, ...fallbacks] = models;

    const model = this.provider.chat(primary, {
      usage: { include: true },
      ...(fallbacks.length > 0 ? { models: [primary, ...fallbacks] } : {}),
      ...(webSearch ? { plugins: [{ id: "web" as const, max_results: webSearch.maxResults }] } : {}),
      ...(reasoning
        ? {
            reasoning:
              "effort" in reasoning
                ? { effort: reasoning.effort }
                : { max_tokens: reasoning.maxTokens },
          }
        : {}),
    });

    const result = streamText({
      model,
      messages,
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

    const [response, providerMetadata, usage] = await Promise.all([
      result.response,
      result.providerMetadata,
      result.usage,
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
      },
    };
  }
}
