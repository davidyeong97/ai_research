import type { AVATARS } from "@/lib/shared";

export type Domain = "coding" | "science" | "creative" | "casual" | "reasoning";
export const DOMAINS: readonly Domain[] = ["coding", "science", "creative", "casual", "reasoning"];

export interface RosterEntry {
  /** Role id, also used as the agent id prefix. */
  role: string;
  avatar: (typeof AVATARS)[number];
  /** Primary OpenRouter model ID. */
  model: string;
  /** Tried in order if the primary fails. */
  fallbackModels: string[];
  /** Domains this role is especially good at (used for ordering). */
  strengths: Domain[];
}

/** Model IDs verified against openrouter.ai/api/v1/models. Override via `createPlan({ roster })`. */
export const DEFAULT_ROSTER: RosterEntry[] = [
  {
    role: "wizard",
    avatar: "wizard",
    model: "anthropic/claude-sonnet-4.6",
    fallbackModels: ["google/gemini-2.5-pro", "deepseek/deepseek-chat-v3.1"],
    strengths: ["coding", "reasoning", "creative"],
  },
  {
    role: "scout",
    avatar: "scout",
    model: "google/gemini-2.5-pro",
    fallbackModels: ["anthropic/claude-sonnet-4.6", "qwen/qwen3-max"],
    strengths: ["science", "casual", "reasoning"],
  },
  {
    role: "rogue",
    avatar: "rogue",
    model: "x-ai/grok-4.3",
    fallbackModels: ["deepseek/deepseek-chat-v3.1", "google/gemini-2.5-pro"],
    strengths: ["creative", "casual", "reasoning"],
  },
  {
    role: "knight",
    avatar: "knight",
    model: "deepseek/deepseek-chat-v3.1",
    fallbackModels: ["qwen/qwen3-max", "anthropic/claude-sonnet-4.6"],
    strengths: ["coding", "science", "reasoning"],
  },
  {
    role: "cleric",
    avatar: "cleric",
    model: "qwen/qwen3-max",
    fallbackModels: ["moonshotai/kimi-k2", "google/gemini-2.5-pro"],
    strengths: ["science", "reasoning", "coding"],
  },
  {
    role: "bard",
    avatar: "bard",
    model: "moonshotai/kimi-k2",
    fallbackModels: ["x-ai/grok-4.3", "qwen/qwen3-max"],
    strengths: ["creative", "casual"],
  },
];

/** Model used by the Lead Orchestrator itself for classification. */
export const LEAD_MODELS = ["anthropic/claude-sonnet-4.6", "google/gemini-2.5-flash"];

/** README §4.1 agent/round limits by complexity. */
export function planShape(complexity: number): {
  minAgents: number;
  maxAgents: number;
  rounds: number;
} {
  if (complexity <= 2) return { minAgents: 1, maxAgents: 2, rounds: 1 };
  if (complexity <= 4) return { minAgents: 2, maxAgents: 3, rounds: 2 };
  return { minAgents: 3, maxAgents: 4, rounds: 3 };
}
