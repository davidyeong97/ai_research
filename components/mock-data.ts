import type { CouncilEvent, OrchestrationPlan } from "@/lib/shared";

export type AgentStatus = "THINKING" | "SEARCHING" | "SPEAKING" | "PAUSED" | "DONE" | "ERROR";

export interface MockAgent {
  id: string;
  role: string;
  avatar: string;
  status: AgentStatus;
  tokensUsed: number;
  tokenBudget: number;
  latestLine: string;
}

export const MOCK_PLAN: OrchestrationPlan = {
  taskId: "task_mock_1",
  complexityScore: 4,
  budgetCapTokens: 30000,
  executionPlan: {
    assignedAgents: [
      { id: "claude", role: "Architect", avatar: "wizard", fallbackModels: [] },
      { id: "gemini", role: "Researcher", avatar: "scout", fallbackModels: [] },
      { id: "grok", role: "Skeptic", avatar: "rogue", fallbackModels: [] },
    ],
    maxRounds: 2,
    toolsAllowed: ["web_search"],
  },
};

export const MOCK_AGENTS: MockAgent[] = [
  {
    id: "claude",
    role: "Architect",
    avatar: "wizard",
    status: "SPEAKING",
    tokensUsed: 6200,
    tokenBudget: 10000,
    latestLine: "I propose we split the service into two bounded contexts.",
  },
  {
    id: "gemini",
    role: "Researcher",
    avatar: "scout",
    status: "SEARCHING",
    tokensUsed: 3400,
    tokenBudget: 10000,
    latestLine: "Pulling benchmarks for both approaches…",
  },
  {
    id: "grok",
    role: "Skeptic",
    avatar: "rogue",
    status: "THINKING",
    tokensUsed: 9300,
    tokenBudget: 10000,
    latestLine: "Hold on — that ignores the migration cost.",
  },
];

const base = { questId: "q_mock", timestamp: "2026-10-06T10:00:00.000Z", data: {} };

export const MOCK_EVENTS: CouncilEvent[] = [
  {
    ...base,
    id: 1,
    round: 1,
    agentId: "claude",
    action: "SPEAKING",
    tokensUsed: 620,
    data: { text: "I propose we split the service into two bounded contexts." },
  },
  {
    ...base,
    id: 2,
    round: 1,
    agentId: "gemini",
    action: "SEARCHING",
    tokensUsed: 340,
    data: { text: "Pulling benchmarks for both approaches…" },
  },
  {
    ...base,
    id: 3,
    round: 1,
    agentId: "grok",
    action: "SPEAKING",
    tokensUsed: 410,
    data: { text: "Hold on — that ignores the migration cost." },
  },
  {
    ...base,
    id: 4,
    round: 2,
    agentId: "claude",
    action: "THINKING",
    tokensUsed: 120,
    data: { text: "Weighing the migration concern…" },
  },
];

export const AVATAR_GLYPH: Record<string, string> = {
  wizard: "🧙",
  scout: "🏹",
  rogue: "🗡️",
  knight: "🛡️",
  cleric: "✨",
  bard: "🎵",
};
