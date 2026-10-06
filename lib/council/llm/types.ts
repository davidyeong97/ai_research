export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type ReasoningOption =
  | { effort: "xhigh" | "high" | "medium" | "low" | "minimal" | "none" }
  | { maxTokens: number };

export interface StreamChatParams {
  messages: ChatMessage[];
  /** Primary model first, followed by fallbacks. */
  models: string[];
  maxTokens: number;
  reasoning?: ReasoningOption;
  signal?: AbortSignal;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  modelUsed: string;
}

export type LLMChunk =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "fallback"; primary: string; modelUsed: string }
  | { type: "usage"; usage: LLMUsage };

export interface LLMClient {
  streamChat(params: StreamChatParams): AsyncIterable<LLMChunk>;
}

/** Collects a full stream into text, reasoning and usage. */
export async function collectChat(stream: AsyncIterable<LLMChunk>) {
  let text = "";
  let reasoning = "";
  let usage: LLMUsage | undefined;
  let fallback: { primary: string; modelUsed: string } | undefined;
  for await (const c of stream) {
    if (c.type === "text") text += c.delta;
    else if (c.type === "reasoning") reasoning += c.delta;
    else if (c.type === "usage") usage = c.usage;
    else fallback = { primary: c.primary, modelUsed: c.modelUsed };
  }
  return { text, reasoning, usage, fallback };
}
