import type { ChatMessage } from "../llm";
import { UNTRUSTED_DATA_NOTICE, wrapFactCheck, wrapPeerMessage, wrapPeerSummary } from "./sanitize";

export interface DebateAgent {
  id: string;
  role: string;
  avatar?: string;
  model?: string;
  fallbackModels: string[];
}

/** One utterance in the debate transcript. */
export interface HistoryEntry {
  round: number;
  agentId: string;
  role: string;
  text: string;
}

export interface PromptContext {
  query: string;
  agent: DebateAgent;
  /** 1-based round number. */
  round: number;
  maxRounds: number;
  /** Everything said so far, oldest first. */
  history: readonly HistoryEntry[];
  /** All agents in this debate (including `agent`). */
  agents: readonly DebateAgent[];
  /** Lead-written summary of rounds 1..round-1 (set for round >= 3). */
  summary?: string;
  /** Fact-checker's verdict on round 1 claims (untrusted data). */
  factCheck?: string;
}

export interface SynthesisContext {
  query: string;
  maxRounds: number;
  history: readonly HistoryEntry[];
  agents: readonly DebateAgent[];
  factCheck?: string;
}

/** Hook: builds the chat messages for one agent turn from the history. */
export type PromptBuilder = (ctx: PromptContext) => ChatMessage[];
/** Hook: builds the lead's final synthesis prompt. */
export type SynthesisPromptBuilder = (ctx: SynthesisContext) => ChatMessage[];

const fmt = (e: HistoryEntry) => wrapPeerMessage(e.agentId, e.text, { role: e.role, round: e.round });

/** Peers' most recent message (one per peer) before `round`. */
export function latestPeerMessages(ctx: PromptContext): HistoryEntry[] {
  const latest = new Map<string, HistoryEntry>();
  for (const e of ctx.history) {
    if (e.agentId === ctx.agent.id || e.round >= ctx.round) continue;
    latest.set(e.agentId, e);
  }
  return [...latest.values()];
}

export function lastOwnMessage(ctx: PromptContext): HistoryEntry | undefined {
  return [...ctx.history].reverse().find((e) => e.agentId === ctx.agent.id && e.round < ctx.round);
}

export const buildAgentPrompt: PromptBuilder = (ctx) => {
  const { agent, round, maxRounds, query } = ctx;
  const system =
    `You are the ${agent.role} of a council of AI experts debating a user's question. ` +
    `This is round ${round} of ${maxRounds}. Stay in your role and be concise. ${UNTRUSTED_DATA_NOTICE}`;
  if (round === 1) {
    return [
      {
        role: "system",
        content: `${system} Give your own independent proposal; you have not seen the other members' views.`,
      },
      { role: "user", content: query },
    ];
  }
  const peers = latestPeerMessages(ctx);
  const own = lastOwnMessage(ctx);
  const parts = [
    `Question:\n${query}`,
    ctx.summary ? `Summary of the debate so far (rounds 1-${round - 1}):\n${wrapPeerSummary(ctx.summary)}` : "",
    ctx.factCheck ? `Fact-check of round-1 claims (verify before relying on them):\n${wrapFactCheck(ctx.factCheck)}` : "",
    own ? `Your previous position:\n${wrapPeerMessage(own.agentId, own.text, { role: own.role, round: own.round })}` : "",
    `Other members' positions from round ${round - 1}:\n${peers.map(fmt).join("\n\n") || "(none)"}`,
    "Critique and rebut weak points in their positions, acknowledge strong ones, and refine your own proposal.",
  ].filter(Boolean);
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ];
};

export const buildSynthesisPrompt: SynthesisPromptBuilder = (ctx) => {
  const lastRound = Math.max(0, ...ctx.history.map((e) => e.round));
  const transcript = ctx.history
    .filter((e) => e.round === lastRound)
    .map(fmt)
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "You are the lead of a council of AI experts. After the debate, synthesize the council's " +
        "positions into one clear, final answer for the user. Resolve disagreements and note caveats. " +
        UNTRUSTED_DATA_NOTICE,
    },
    {
      role: "user",
      content: `Question:\n${ctx.query}\n\nFinal-round positions:\n${transcript || "(none)"}\n\n${
        ctx.factCheck ? `Fact-check of round-1 claims:\n${wrapFactCheck(ctx.factCheck)}\n\n` : ""
      }Write the final answer.`,
    },
  ];
};

export interface SummaryContext {
  query: string;
  /** Summary of earlier rounds, if one already exists. */
  previousSummary?: string;
  /** Entries not yet covered by `previousSummary`. */
  entries: readonly HistoryEntry[];
  upToRound: number;
}

/** Lead prompt that compacts the debate so far (target <= ~400 tokens). */
export function buildSummaryPrompt(ctx: SummaryContext): ChatMessage[] {
  const transcript = ctx.entries.map(fmt).join("\n\n");
  return [
    {
      role: "system",
      content:
        "You are the lead of a council of AI experts. Summarize the debate so far in at most " +
        "400 tokens: each member's key positions, points of agreement, and open disagreements. " +
        "Be faithful and neutral; do not add new arguments. " +
        UNTRUSTED_DATA_NOTICE,
    },
    {
      role: "user",
      content: [
        `Question:\n${ctx.query}`,
        ctx.previousSummary ? `Summary of earlier rounds:\n${wrapPeerSummary(ctx.previousSummary)}` : "",
        `Transcript (through round ${ctx.upToRound}):\n${transcript || "(none)"}`,
        "Write the compact summary.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

export interface FactCheckContext {
  query: string;
  agent: DebateAgent;
  round: number;
  /** Claims to verify: the round's entries by peers of the fact-checker. */
  entries: readonly HistoryEntry[];
  searchEnabled: boolean;
}

/** Prompt for the fact-checker: cross-verify peers' factual claims, concise verdict. */
export function buildFactCheckPrompt(ctx: FactCheckContext): ChatMessage[] {
  const transcript = ctx.entries.map(fmt).join("\n\n");
  return [
    {
      role: "system",
      content:
        `You are the ${ctx.agent.role} of a council of AI experts, acting as fact-checker. ` +
        "Identify the concrete factual claims made by the other members, verify them" +
        (ctx.searchEnabled ? " (use web search where helpful)" : " from your own knowledge") +
        ", and give a concise verdict (at most 200 words): list each key claim as VERIFIED, DISPUTED " +
        "or UNVERIFIED with a one-line reason. Do not add new proposals. " +
        UNTRUSTED_DATA_NOTICE,
    },
    {
      role: "user",
      content: `Question:\n${ctx.query}\n\nClaims from round ${ctx.round}:\n${transcript || "(none)"}\n\nWrite the fact-check verdict.`,
    },
  ];
}
