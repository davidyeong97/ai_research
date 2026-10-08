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
  lastThought?: string;
  lastCitations?: Citation[];
  lastLatencyMs?: number;
}

export interface Citation {
  url: string;
  title?: string;
}

/** What the inspector is showing: an agent, optionally pinned to one message. */
export interface InspectSelection {
  agentId: string;
  entryId?: number;
}

export type TranscriptKind =
  | "message"
  | "status"
  | "final"
  | "error"
  | "director"
  | "quest"
  | "digest";

export interface AttachmentRef {
  id: string;
  filename: string;
  kind: "image" | "pdf" | "text";
}

export interface PendingApproval {
  plan: {
    complexity?: number;
    rounds?: number;
    tools: string[];
    agents: { id: string; role: string; model?: string }[];
  };
  estimatedMaxTokens: number | null;
  estimatedMaxCostUsd: number | null;
  attachments: AttachmentRef[];
}

export interface TranscriptEntry {
  /** Event id (seq). */
  id: number;
  round: number;
  agentId: string;
  action: CouncilAction;
  kind: TranscriptKind;
  text: string;
  tokensUsed: number;
  thought?: string;
  citations?: Citation[];
  model?: string;
  costUsd?: number;
  latencyMs?: number;
  attachments?: AttachmentRef[];
}

export type QuestPhase = "idle" | "running" | "done" | "error";

export interface QuestState {
  questId: string | null;
  plan: OrchestrationPlan | null;
  phase: QuestPhase;
  /** True while the director has paused deliberation. */
  paused: boolean;
  /** Set while a gated quest waits for plan approval. */
  pendingApproval: PendingApproval | null;
  agents: AgentState[];
  transcript: TranscriptEntry[];
  finalAnswer: string | null;
  lastEventId: number;
  /** Highest round seen across events (0 before any). */
  currentRound: number;
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
  paused: false,
  pendingApproval: null,
  agents: [],
  transcript: [],
  finalAnswer: null,
  lastEventId: 0,
  currentRound: 0,
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

function parseAttachments(v: unknown): AttachmentRef[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a): AttachmentRef[] => {
    const r = rec(a);
    const id = str(r?.id);
    const kind = str(r?.kind);
    if (!id || (kind !== "image" && kind !== "pdf" && kind !== "text")) return [];
    return [{ id, filename: str(r?.filename) ?? id, kind }];
  });
}

function parseCitations(v: unknown): Citation[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.flatMap((c): Citation[] => {
    const r = rec(c);
    const url = str(r?.url);
    return url ? [{ url, title: str(r?.title) }] : [];
  });
  return out.length ? out : undefined;
}

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

  const next: QuestState = {
    ...state,
    lastEventId: e.id,
    currentRound: Math.max(state.currentRound, e.round),
  };
  const d = e.data;
  // Any activity after an approval gate means the plan was approved.
  if (state.pendingApproval && e.action !== "PAUSED") next.pendingApproval = null;
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
    case "CONSENSUS": {
      const status = str(d.statusMessage);
      next.agents = patchAgent(state.agents, e.agentId, (a) => ({
        ...a,
        status: e.action,
        latestLine: status ?? a.latestLine,
      }));
      if (status) next.transcript = [...state.transcript, entry("status", status)];
      return next;
    }
    case "PAUSED": {
      if (d.awaitingApproval === true) {
        const p = rec(d.plan);
        const agents = Array.isArray(p?.agents) ? p.agents : [];
        next.pendingApproval = {
          plan: {
            complexity: num(p?.complexity),
            rounds: num(p?.rounds),
            tools: Array.isArray(p?.tools)
              ? p.tools.filter((t): t is string => typeof t === "string")
              : [],
            agents: agents.flatMap((a) => {
              const r = rec(a);
              const id = str(r?.id);
              return id ? [{ id, role: str(r?.role) ?? id, model: str(r?.model) }] : [];
            }),
          },
          estimatedMaxTokens: num(d.estimatedMaxTokens) ?? null,
          estimatedMaxCostUsd: num(d.estimatedMaxCostUsd) ?? null,
          attachments: parseAttachments(d.attachments),
        };
        return next;
      }
      if (d.paused === true) next.paused = true;
      else if (d.paused === false) next.paused = false;
      const status = str(d.statusMessage);
      if (status) {
        next.agents = patchAgent(state.agents, e.agentId, (a) => ({
          ...a,
          status: "PAUSED",
          latestLine: status,
        }));
        next.transcript = [...state.transcript, entry("status", status)];
      }
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
      const rawMessage = str(d.message) ?? str(d.text) ?? "";
      const message = d.factCheck === true ? `Fact-check 🔍: ${rawMessage}` : rawMessage;
      if (e.agentId === "user" && d.userQuery === true) {
        next.transcript = [
          ...state.transcript,
          { ...entry("quest", rawMessage), attachments: parseAttachments(d.attachments) },
        ];
        return next;
      }
      if (e.agentId === "user") {
        next.transcript = [...state.transcript, entry("director", message)];
        return next;
      }
      if (d.attachmentDigest === true) {
        next.agents = patchAgent(state.agents, e.agentId, (a) => ({
          ...a,
          status: "SPEAKING",
          tokensUsed: a.tokensUsed + e.tokensUsed,
          costUsd: a.costUsd + (num(d.costUsd) ?? 0),
        }));
        next.transcript = [...state.transcript, entry("digest", rawMessage)];
        return next;
      }
      const budget = rec(d.budget);
      const ratio = num(budget?.remainingRatio);
      const thought = str(d.thought)?.trim() || undefined;
      const citations = parseCitations(d.citations);
      const latencyMs = num(d.latencyMs);
      next.agents = patchAgent(state.agents, e.agentId, (a) => ({
        ...a,
        status: "SPEAKING",
        latestLine: message,
        tokensUsed: a.tokensUsed + e.tokensUsed,
        remainingRatio: ratio === undefined ? a.remainingRatio : Math.max(0, Math.min(1, ratio)),
        modelUsed: str(d.model) ?? a.modelUsed,
        costUsd: a.costUsd + (num(d.costUsd) ?? 0),
        lastThought: thought ?? a.lastThought,
        lastCitations: citations ?? a.lastCitations,
        lastLatencyMs: latencyMs ?? a.lastLatencyMs,
      }));
      next.transcript = [
        ...state.transcript,
        {
          ...entry("message", message),
          thought,
          citations,
          model: str(d.model),
          costUsd: num(d.costUsd),
          latencyMs,
        },
      ];
      return next;
    }
    case "DONE": {
      next.paused = false;
      next.pendingApproval = null;
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
      next.paused = false;
      next.pendingApproval = null;
      next.error = message;
      next.agents = patchAgent(state.agents, e.agentId, (a) => ({ ...a, status: "ERROR" }));
      next.transcript = [...state.transcript, entry("error", message)];
      return next;
    }
  }
}
