import type { CouncilAction, CouncilEvent, OrchestrationPlan } from "@/lib/shared";

export type AgentStatus = CouncilAction | "IDLE";

export interface AgentState {
  id: string;
  role: string;
  avatar: string;
  status: AgentStatus;
  tokensUsed: number;
  /** 0..1 share of the token budget left, from SPEAKING data.budget. */
  remainingRatio: number;
  latestLine: string;
  /** Configured primary model, if known. */
  model?: string;
  /** Model that actually answered (differs from `model` after a fallback). */
  modelUsed?: string;
  fallback?: { primary: string; modelUsed: string };
  costUsd: number;
}

export type TranscriptKind = "message" | "status" | "final" | "error";

export interface TranscriptEntry {
  /** Event id (seq). */
  id: number;
  round: number;
  agentId: string;
  action: CouncilAction;
  kind: TranscriptKind;
  text: string;
  tokensUsed: number;
}

export type QuestPhase = "idle" | "running" | "done" | "error";

export interface QuestState {
  questId: string | null;
  plan: OrchestrationPlan | null;
  phase: QuestPhase;
  agents: AgentState[];
  transcript: TranscriptEntry[];
  finalAnswer: string | null;
  lastEventId: number;
  totalTokens: number;
  totalCostUsd: number;
  error: string | null;
}

export type QuestAction =
  | { type: "reset" }
  | { type: "start"; questId: string; plan: OrchestrationPlan }
  | { type: "event"; event: CouncilEvent };

export const initialQuestState: QuestState = {
  questId: null,
  plan: null,
  phase: "idle",
  agents: [],
  transcript: [],
  finalAnswer: null,
  lastEventId: 0,
  totalTokens: 0,
  totalCostUsd: 0,
  error: null,
};

const LEAD: Pick<AgentState, "id" | "role" | "avatar"> = {
  id: "lead",
  role: "Lead",
  avatar: "knight",
};

function newAgent(
  base: Pick<AgentState, "id" | "role" | "avatar"> & { model?: string },
): AgentState {
  return {
    ...base,
    status: "IDLE",
    tokensUsed: 0,
    remainingRatio: 1,
    latestLine: "",
    costUsd: 0,
  };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function patchAgent(
  agents: AgentState[],
  id: string,
  fn: (a: AgentState) => AgentState,
): AgentState[] {
  if (agents.some((a) => a.id === id)) return agents.map((a) => (a.id === id ? fn(a) : a));
  const base = id === "lead" ? LEAD : { id, role: id, avatar: "wizard" };
  return [...agents, fn(newAgent(base))];
}

export function questReducer(state: QuestState, action: QuestAction): QuestState {
  switch (action.type) {
    case "reset":
      return initialQuestState;
    case "start":
      return {
        ...initialQuestState,
        questId: action.questId,
        plan: action.plan,
        phase: "running",
        agents: action.plan.executionPlan.assignedAgents.map((a) =>
          newAgent({ id: a.id, role: a.role, avatar: a.avatar, model: a.model }),
        ),
      };
    case "event":
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: QuestState, e: CouncilEvent): QuestState {
  if (state.questId !== null && e.questId !== state.questId) return state;
  // Reconnect replays may resend events we already have.
  if (e.id <= state.lastEventId) return state;

  const next: QuestState = { ...state, lastEventId: e.id };
  const d = e.data;
  const entry = (kind: TranscriptKind, text: string): TranscriptEntry => ({
    id: e.id,
    round: e.round,
    agentId: e.agentId,
    action: e.action,
    kind,
    text,
    tokensUsed: e.tokensUsed,
  });

  switch (e.action) {
    case "THINKING":
    case "SEARCHING":
    case "FACT_CHECKING":
    case "CONSENSUS":
    case "PAUSED": {
      const status = str(d.statusMessage);
      next.agents = patchAgent(state.agents, e.agentId, (a) => ({
        ...a,
        status: e.action,
        latestLine: status ?? a.latestLine,
      }));
      if (status) next.transcript = [...state.transcript, entry("status", status)];
      return next;
    }
    case "FALLBACK": {
      const primary = str(d.primary) ?? "";
      const modelUsed = str(d.modelUsed) ?? "";
      next.agents = patchAgent(state.agents, e.agentId, (a) => ({
        ...a,
        status: "FALLBACK",
        fallback: { primary, modelUsed },
        modelUsed: modelUsed || a.modelUsed,
      }));
      next.transcript = [
        ...state.transcript,
        entry("status", `Fell back from ${primary || "primary model"} to ${modelUsed || "backup"}`),
      ];
      return next;
    }
    case "SPEAKING": {
      const message = str(d.message) ?? str(d.text) ?? "";
      const budget = rec(d.budget);
      const ratio = num(budget?.remainingRatio);
      next.agents = patchAgent(state.agents, e.agentId, (a) => ({
        ...a,
        status: "SPEAKING",
        latestLine: message,
        tokensUsed: a.tokensUsed + e.tokensUsed,
        remainingRatio: ratio === undefined ? a.remainingRatio : Math.max(0, Math.min(1, ratio)),
        modelUsed: str(d.model) ?? a.modelUsed,
        costUsd: a.costUsd + (num(d.costUsd) ?? 0),
      }));
      next.transcript = [...state.transcript, entry("message", message)];
      return next;
    }
    case "DONE": {
      if (d.cancelled === true) {
        next.phase = "done";
        next.agents = state.agents.map((a) => ({ ...a, status: "DONE" }));
        next.transcript = [...state.transcript, entry("status", "Quest cancelled")];
        return next;
      }
      const finalAnswer = str(d.finalAnswer) ?? null;
      next.phase = "done";
      next.finalAnswer = finalAnswer;
      next.totalTokens = num(d.totalTokens) ?? state.totalTokens;
      next.totalCostUsd = num(d.totalCostUsd) ?? state.totalCostUsd;
      next.agents = state.agents.map((a) => ({ ...a, status: "DONE" }));
      // The lead's synthesis turn already streamed the same text as SPEAKING; show it once.
      const transcript = finalAnswer
        ? state.transcript.filter(
            (t) => !(t.agentId === "lead" && t.kind === "message" && t.text === finalAnswer),
          )
        : state.transcript;
      next.transcript = finalAnswer ? [...transcript, entry("final", finalAnswer)] : transcript;
      return next;
    }
    case "ERROR": {
      const message = str(d.message) ?? str(d.reason) ?? "Quest failed";
      next.phase = "error";
      next.error = message;
      next.agents = patchAgent(state.agents, e.agentId, (a) => ({ ...a, status: "ERROR" }));
      next.transcript = [...state.transcript, entry("error", message)];
      return next;
    }
  }
}
