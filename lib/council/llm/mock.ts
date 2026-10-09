import { textOf } from "./types";
import type {
  Citation,
  EmbedParams,
  EmbedResult,
  LLMChunk,
  LLMClient,
  LLMUsage,
  StreamChatParams,
} from "./types";

export const MOCK_EMBED_DIM = 64;

/** Deterministic bag-of-words feature-hashing vector: similar texts have high cosine. */
export function hashEmbedding(text: string, dim = MOCK_EMBED_DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
    v[(h >>> 0) % dim] += (h & 0x80000000) === 0 ? 1 : -1;
  }
  return v;
}

export interface MockResponse {
  text?: string;
  reasoning?: string;
  /** Model that "served" the request; defaults to the primary model. */
  modelUsed?: string;
  usage?: Partial<Omit<LLMUsage, "modelUsed">>;
  /** Simulated finish reason ("length" = truncated by the token limit). */
  finishReason?: string;
  /** Emitted only when the request has webSearch set. */
  citations?: Citation[];
  error?: Error;
}

export type MockResponder = (params: StreamChatParams) => MockResponse | string;

/** Deterministic in-memory LLMClient for tests (no network). */
export class MockLLMClient implements LLMClient {
  readonly calls: StreamChatParams[] = [];
  readonly embedCalls: EmbedParams[] = [];
  /** Set to make embed() reject (tests graceful degradation). */
  embedError?: Error;
  private queue: Array<MockResponse | string> = [];

  constructor(private readonly responder?: MockResponder | MockResponse | string) {}

  /** Queue responses consumed in order, before falling back to the responder. */
  enqueue(...responses: Array<MockResponse | string>): this {
    this.queue.push(...responses);
    return this;
  }

  async embed(params: EmbedParams): Promise<EmbedResult> {
    this.embedCalls.push(params);
    if (this.embedError) throw this.embedError;
    return {
      vectors: params.texts.map((t) => hashEmbedding(t)),
      tokens: params.texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0),
      costUsd: 0,
    };
  }

  async *streamChat(params: StreamChatParams): AsyncIterable<LLMChunk> {
    this.calls.push(params);
    const raw =
      this.queue.shift() ??
      (typeof this.responder === "function" ? this.responder(params) : this.responder) ??
      "mock response";
    const res: MockResponse = typeof raw === "string" ? { text: raw } : raw;
    if (res.error) throw res.error;

    const primary = params.models[0];
    const modelUsed = res.modelUsed ?? primary;
    const text = res.text ?? "";

    if (res.reasoning) yield { type: "reasoning", delta: res.reasoning };
    for (const delta of text.match(/\S+\s*|\s+/g) ?? []) {
      if (params.signal?.aborted) return;
      yield { type: "text", delta };
    }
    if (params.webSearch && res.citations?.length) {
      yield { type: "citations", citations: res.citations.slice(0, params.webSearch.maxResults) };
    }
    if (modelUsed !== primary) yield { type: "fallback", primary, modelUsed };
    const approx = (s: string) => Math.ceil(s.length / 4);
    yield {
      type: "usage",
      usage: {
        promptTokens:
          res.usage?.promptTokens ?? approx(params.messages.map((m) => textOf(m.content)).join("")),
        completionTokens: res.usage?.completionTokens ?? approx(text),
        costUsd: res.usage?.costUsd ?? 0,
        modelUsed,
        finishReason: res.finishReason ?? res.usage?.finishReason ?? "stop",
      },
    };
  }
}
