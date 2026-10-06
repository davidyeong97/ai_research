import type { Citation, LLMChunk, LLMClient, LLMUsage, StreamChatParams } from "./types";

export interface MockResponse {
  text?: string;
  reasoning?: string;
  /** Model that "served" the request; defaults to the primary model. */
  modelUsed?: string;
  usage?: Partial<Omit<LLMUsage, "modelUsed">>;
  /** Emitted only when the request has webSearch set. */
  citations?: Citation[];
  error?: Error;
}

export type MockResponder = (params: StreamChatParams) => MockResponse | string;

/** Deterministic in-memory LLMClient for tests (no network). */
export class MockLLMClient implements LLMClient {
  readonly calls: StreamChatParams[] = [];
  private queue: Array<MockResponse | string> = [];

  constructor(private readonly responder?: MockResponder | MockResponse | string) {}

  /** Queue responses consumed in order, before falling back to the responder. */
  enqueue(...responses: Array<MockResponse | string>): this {
    this.queue.push(...responses);
    return this;
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
          res.usage?.promptTokens ?? approx(params.messages.map((m) => m.content).join("")),
        completionTokens: res.usage?.completionTokens ?? approx(text),
        costUsd: res.usage?.costUsd ?? 0,
        modelUsed,
      },
    };
  }
}
