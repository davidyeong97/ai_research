export type ChatRole = "system" | "user" | "assistant";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: Uint8Array | string; mediaType: string }
  | { type: "file"; data: Uint8Array | string; mediaType: "application/pdf"; filename: string };

export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: ChatRole;
  /** Plain string (text-only) or multimodal parts. `data` strings are base64. */
  content: MessageContent;
}

/** Concatenated text of a message content (media parts are omitted). */
export function textOf(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** True when any message carries an image or file part. */
export function hasMedia(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) => typeof m.content !== "string" && m.content.some((p) => p.type !== "text"),
  );
}

export type ReasoningOption =
  { effort: "xhigh" | "high" | "medium" | "low" | "minimal" | "none" } | { maxTokens: number };

export interface StreamChatParams {
  messages: ChatMessage[];
  /** Primary model first, followed by fallbacks. */
  models: string[];
  maxTokens: number;
  reasoning?: ReasoningOption;
  /** Enable OpenRouter web search (web plugin) for this call. */
  webSearch?: { maxResults: number };
  signal?: AbortSignal;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  modelUsed: string;
}

export interface Citation {
  url: string;
  title?: string;
}

export type LLMChunk =
  | { type: "citations"; citations: Citation[] }
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
  const citations: Citation[] = [];
  let usage: LLMUsage | undefined;
  let fallback: { primary: string; modelUsed: string } | undefined;
  for await (const c of stream) {
    if (c.type === "text") text += c.delta;
    else if (c.type === "reasoning") reasoning += c.delta;
    else if (c.type === "usage") usage = c.usage;
    else if (c.type === "citations") citations.push(...c.citations);
    else fallback = { primary: c.primary, modelUsed: c.modelUsed };
  }
  return { text, reasoning, usage, fallback, citations };
}
