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
  lastTruncated?: boolean;
  lastCitations?: Citation[];
  /** Query currently being searched (set while status is SEARCHING). */
  searchQuery?: string;
  /** Queries searched for the latest turn. */
  lastSearchQueries?: string[];
  lastSearchProvider?: string;
  lastSearchCostUsd?: number;
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
  "message" | "status" | "final" | "error" | "director" | "quest" | "digest" | "memory";

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

export interface RecalledMemoryRef {
  id: string;
  kind?: string;
  preview: string;
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
  /** Output hit the token limit and was cut off. */
  truncated?: boolean;
  citations?: Citation[];
  searchQueries?: string[];
  searchProvider?: string;
  searchCostUsd?: number;
  model?: string;
  costUsd?: number;
  latencyMs?: number;
  attachments?: AttachmentRef[];
  /** Full injected (fenced) memory block, for kind "memory". */
  block?: string;
  memories?: RecalledMemoryRef[];
}

function parseStrings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  return out.length ? out : undefined;
}

export type QuestPhase = "idle" | "running" | "done" | "error";

export interface QuestState {
  questId: string | null;
  /** Who started the quest ("web" | "mcp"); null before any quest. */
  source: string | null;
  plan: OrchestrationPlan | null;
  phase: QuestPhase;
  /** True while the director has paused deliberation. */
  paused: boolean;
  /** Set while a gated quest waits for plan approval. */
  pendingApproval: PendingApproval | null;
  agents: AgentState[];
  transcript: TranscriptEntry[];
  /** Memories recalled for this quest (from RECALL events). */
  recalled: RecalledMemoryRef[];
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
  | { type: "start"; questId: string; plan: OrchestrationPlan; source?: string }
  /** Attach to an existing quest; its events are replayed from seq 0. */
  | { type: "attach"; questId: string; source: string; }
  | { type: "event"; event: CouncilEvent };

export const initialQuestState: QuestState = {
  questId: null,
  source: null,
  plan: null,
  phase: "idle",
  paused: false,
  pendingApproval: null,
  agents: [],
  transcript: [],
  recalled: [],
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
        source: action.source ?? "web",
        plan: action.plan,
        phase: "running",
        agents: action.plan.executionPlan.assignedAgents.map((a) =>
          newAgent({ id: a.id, role: a.role, avatar: a.avatar, model: a.model }),
        ),
      };
    case "attach":
      return { ...initialQuestState, questId: action.questId, source: action.source, phase: "running" };
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
      const action = e.action;
      const query = e.action === "SEARCHING" ? str(d.query)?.trim() || undefined : undefined;
      const provider = e.action === "SEARCHING" ? str(d.provider) : undefined;
      next.agents = patchAgent(state.agents, e.agentId, (a) => {
        const prior = a.status === "SEARCHING" ? (a.lastSearchQueries ?? []) : [];
        return {
          ...a,
          status: action,
          latestLine: status ?? a.latestLine,
          searchQuery: query,
          ...(query
            ? {
                lastSearchQueries: prior.includes(query) ? prior : [...prior, query],
                lastSearchProvider: provider ?? a.lastSearchProvider,
              }
            : {}),
        };
      });
      if (status) next.transcript = [...state.transcript, entry("status", status)];
      return next;
    }
    case "RECALL": {
      const count = num(d.count) ?? 0;
      const previews = Array.isArray(d.preview)
        ? d.preview.filter((p): p is string => typeof p === "string")
        : str(d.preview)
          ? [str(d.preview) as string]
          : [];
      const ids = Array.isArray(d.ids) ? d.ids.filter((x): x is string => typeof x === "string") : [];
      const kinds = Array.isArray(d.kinds) ? d.kinds : [];
      const memories: RecalledMemoryRef[] = previews.map((preview, i) => ({
        id: ids[i] ?? `recalled-${e.id}-${i}`,
        kind: str(kinds[i]),
        preview,
      }));
      const joined = previews.join(" | ");
      const short = joined.length > 140 ? `${joined.slice(0, 139)}…` : joined;
      const text = `🧠 Council recalled ${count} ${count === 1 ? "memory" : "memories"}${short ? `: ${short}` : ""}`;
      next.recalled = [...state.recalled, ...memories];
      next.transcript = [
        ...state.transcript,
        { ...entry("memory", text), block: str(d.block), memories },
      ];
      if (state.agents.some((a) => a.id === e.agentId)) {
        next.agents = patchAgent(state.agents, e.agentId, (a) => ({ ...a, status: "RECALL" }));
      }
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
      const searchQueries = parseStrings(d.searchQueries);
      const searchProvider = str(d.searchProvider);
      const searchCostUsd = num(d.searchCostUsd);
      const truncated = d.truncated === true;
      next.agents = patchAgent(state.agents, e.agentId, (a) => ({
        ...a,
        status: "SPEAKING",
        latestLine: message,
        tokensUsed: a.tokensUsed + e.tokensUsed,
        remainingRatio: ratio === undefined ? a.remainingRatio : Math.max(0, Math.min(1, ratio)),
        modelUsed: str(d.model) ?? a.modelUsed,
        costUsd: a.costUsd + (num(d.costUsd) ?? 0),
        lastThought: thought ?? a.lastThought,
        lastTruncated: truncated,
        lastCitations: citations ?? a.lastCitations,
        searchQuery: undefined,
        lastSearchQueries: searchQueries ?? (a.status === "SEARCHING" ? a.lastSearchQueries : undefined),
        lastSearchProvider: searchProvider ?? (searchQueries ? undefined : a.lastSearchProvider),
        lastSearchCostUsd: searchCostUsd,
        lastLatencyMs: latencyMs ?? a.lastLatencyMs,
      }));
      next.transcript = [
        ...state.transcript,
        {
          ...entry("message", message),
          thought,
          ...(truncated ? { truncated: true } : {}),
          citations,
          ...(searchQueries ? { searchQueries } : {}),
          ...(searchProvider ? { searchProvider } : {}),
          ...(searchCostUsd !== undefined ? { searchCostUsd } : {}),
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
