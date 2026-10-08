import { desc, eq, and, gte, inArray } from "drizzle-orm";
import { getDb, schema, type DB } from "../db";
import type { CouncilEvent, OrchestrationPlan } from "../shared";
import { getBus, type EventBus } from "./bus";
import { costCapFromEnv } from "./budget";
import { getControl, MAX_GUIDANCE_CHARS } from "./control";
import type { AttachmentMeta } from "./debate/attachment-context";
import { createQuest, planSummary, type QuestDeps } from "./quests";

/**
 * Transport-agnostic quest operations shared by the HTTP API routes and the
 * MCP server. Errors are thrown as ServiceError (never as raw HTTP responses).
 */

export type QuestSource = "web" | "mcp";
export type ControlAction = "pause" | "resume" | "inject" | "cancel";

export type ServiceErrorCode = "invalid" | "not_found" | "conflict" | "limit";

export class ServiceError extends Error {
  readonly name = "ServiceError";
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
  get httpStatus(): number {
    return this.code === "invalid"
      ? 400
      : this.code === "not_found"
        ? 404
        : this.code === "limit"
          ? 429
          : 409;
  }
}

export type ServiceDeps = Pick<QuestDeps, "db" | "bus" | "llm" | "controlTimeoutMs">;

const MAX_WAIT_MS = 50_000;
const MAX_RECENT = 50;
const SPEAKING_TRUNCATE = 500;
const MAX_LIST = 50;
const TERMINAL_STATUSES = new Set([
  "done",
  "error",
  "budget_exceeded",
  "cost_cap_exceeded",
  "cancelled",
  "interrupted",
]);

const ctx = (deps: ServiceDeps) => ({ db: deps.db ?? getDb(), bus: deps.bus ?? getBus() });

export interface StartQuestInput {
  query: string;
  attachmentIds?: string[];
  remember?: boolean;
  source: QuestSource;
  /** May only LOWER the MAX_COST_USD_PER_QUEST cap. */
  maxCostUsd?: number;
  /** Skip the human approval gate (complexity-5 quests only). */
  autoApprove?: boolean;
}

export interface StartQuestResult {
  questId: string;
  plan: OrchestrationPlan;
  status: string;
  /** Resolves when the debate finishes (tests / internal use). */
  attachments: AttachmentMeta[];
  done: Promise<void>;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Guardrails for machine (MCP) clients; throws ServiceError("limit"). */
function enforceMcpLimits(db: DB): void {
  const maxConcurrent = Math.floor(envNumber("MCP_MAX_CONCURRENT", 2));
  const active = db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.source, "mcp"),
        inArray(schema.sessions.status, ["running", "awaiting_approval"]),
      ),
    )
    .all().length;
  if (active >= maxConcurrent) {
    throw new ServiceError(
      "limit",
      `Too many concurrent MCP quests (${active}/${maxConcurrent}). Wait for a running quest to finish or cancel one, then retry.`,
      "mcp_max_concurrent",
    );
  }
  const dailyCap = envNumber("MCP_DAILY_COST_USD", 2.0);
  const since = Date.now() - 24 * 3600 * 1000;
  const spent = db
    .select({ cost: schema.sessions.totalCostUsd })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.source, "mcp"), gte(schema.sessions.createdAt, since)))
    .all()
    .reduce((sum, r) => sum + (r.cost ?? 0), 0);
  if (spent >= dailyCap) {
    throw new ServiceError(
      "limit",
      `Daily MCP spend cap reached ($${spent.toFixed(2)} of $${dailyCap.toFixed(2)} in the last 24h). Try again later or raise MCP_DAILY_COST_USD.`,
      "mcp_daily_cost",
    );
  }
}

export async function startQuest(input: StartQuestInput, deps: ServiceDeps = {}): Promise<StartQuestResult> {
  const query = input.query?.trim() ?? "";
  if (!query && !input.attachmentIds?.length) throw new ServiceError("invalid", "query is required");
  let costCapUsd = costCapFromEnv();
  if (input.source === "mcp") {
    enforceMcpLimits(deps.db ?? getDb());
    costCapUsd = Math.min(costCapUsd, envNumber("MCP_DEFAULT_MAX_COST_USD", 0.3) || costCapUsd);
  }
  if (input.maxCostUsd !== undefined) {
    if (!Number.isFinite(input.maxCostUsd) || input.maxCostUsd <= 0) {
      throw new ServiceError("invalid", "maxCostUsd must be a positive number");
    }
    costCapUsd = Math.min(costCapUsd, input.maxCostUsd);
  }
  const { questId, plan, done, attachments } = await createQuest(
    query,
    { ...deps, source: input.source, costCapUsd },
    { attachmentIds: input.attachmentIds, remember: input.remember },
  );
  let status = plan.requiresApproval ? "awaiting_approval" : "running";
  if (plan.requiresApproval && input.autoApprove && getControl(questId)?.decide(true)) {
    status = "running";
  }
  return { questId, plan, status, attachments, done };
}

export interface EventSummary {
  seq: number;
  round: number;
  agentId: string;
  action: string;
  tokensUsed: number;
  message?: string;
  statusMessage?: string;
  data?: Record<string, unknown>;
}

export interface QuestSnapshot {
  questId: string;
  query: string;
  status: string;
  source: string;
  complexity: number | null;
  rounds: number | null;
  agents: { id: string; role: string; model: string }[];
  awaitingApproval: boolean;
  paused: boolean;
  totalTokens: number;
  totalCostUsd: number;
  finalAnswer?: string;
  error?: string;
  lastSeq: number;
  recent: EventSummary[];
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function summarize(e: CouncilEvent): EventSummary {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const out: EventSummary = {
    seq: e.id,
    round: e.round,
    agentId: e.agentId,
    action: e.action,
    tokensUsed: e.tokensUsed,
  };
  if (typeof d.message === "string") {
    out.message = e.action === "SPEAKING" ? truncate(d.message, SPEAKING_TRUNCATE) : truncate(d.message, 300);
  }
  if (typeof d.statusMessage === "string") out.statusMessage = d.statusMessage;
  if (e.action === "PAUSED") {
    if (d.awaitingApproval) out.data = { awaitingApproval: true };
    else if (typeof d.paused === "boolean") out.data = { paused: d.paused };
  } else if (e.action === "ERROR" && typeof d.reason === "string") {
    out.data = { reason: d.reason };
  } else if (e.action === "DONE" && d.cancelled) {
    out.data = { cancelled: true };
  }
  return out;
}

function lastSeqOf(bus: EventBus, questId: string): number {
  // Cheap enough: the replay is a primary-key indexed range scan.
  const ev = bus.replay(questId, 0);
  return ev.length ? ev[ev.length - 1].id : 0;
}

export function getQuestSnapshot(
  questId: string,
  opts: { sinceSeq?: number } = {},
  deps: ServiceDeps = {},
): QuestSnapshot {
  const { db, bus } = ctx(deps);
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, questId)).get();
  if (!session) throw new ServiceError("not_found", "quest not found");
  const plan = db
    .select()
    .from(schema.orchestrationPlans)
    .where(eq(schema.orchestrationPlans.sessionId, questId))
    .get();
  const all = bus.replay(questId, 0);
  const since = Math.max(0, Math.floor(opts.sinceSeq ?? 0));
  const recent = all.filter((e) => e.id > since).slice(-MAX_RECENT).map(summarize);
  const matrix = (plan?.agentMatrix ?? []) as { id: string; role: string; model: string }[];
  const lastError = [...all].reverse().find((e) => e.action === "ERROR");
  const errData = (lastError?.data ?? {}) as Record<string, unknown>;
  const awaitingApproval = session.status === "awaiting_approval";
  const snap: QuestSnapshot = {
    questId,
    query: session.query,
    status: session.status,
    source: session.source,
    complexity: plan?.complexity ?? null,
    rounds: plan?.rounds ?? null,
    agents: matrix.map((a) => ({ id: a.id, role: a.role, model: a.model })),
    awaitingApproval,
    paused: !!getControl(questId)?.paused,
    totalTokens: session.totalTokens,
    totalCostUsd: session.totalCostUsd,
    lastSeq: all.length ? all[all.length - 1].id : 0,
    recent,
  };
  if (session.status === "done" && session.outcome) snap.finalAnswer = session.outcome;
  if (lastError && session.status !== "done") {
    snap.error = String(errData.message ?? errData.reason ?? session.status);
  } else if (session.status === "cancelled") {
    snap.error = "cancelled";
  }
  return snap;
}

/**
 * Resolves with a snapshot once the quest is DONE/ERROR (or otherwise
 * terminal), waiting for approval, or `timeoutMs` (capped at 50s) elapses.
 * If `untilSeqAfter` is given it also resolves as soon as any event with a
 * higher seq exists (long-poll for progress).
 */
export function waitForQuest(
  questId: string,
  opts: { timeoutMs?: number; untilSeqAfter?: number } = {},
  deps: ServiceDeps = {},
): Promise<QuestSnapshot> {
  const { db, bus } = ctx(deps);
  const timeoutMs = Math.max(0, Math.min(opts.timeoutMs ?? MAX_WAIT_MS, MAX_WAIT_MS));
  const snap = () => getQuestSnapshot(questId, { sinceSeq: opts.untilSeqAfter }, deps);
  const settled = () => {
    const s = db.select({ status: schema.sessions.status }).from(schema.sessions).where(eq(schema.sessions.id, questId)).get();
    if (!s) throw new ServiceError("not_found", "quest not found");
    return TERMINAL_STATUSES.has(s.status) || s.status === "awaiting_approval";
  };
  if (settled() || timeoutMs === 0) return Promise.resolve(snap());
  const start = opts.untilSeqAfter ?? lastSeqOf(bus, questId);
  return new Promise((resolve) => {
    let unsub: (() => void) | undefined; // eslint-disable-line prefer-const
    let finished = false;
    const timer = setTimeout(() => finish(), timeoutMs);
    timer.unref?.();
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsub?.();
      resolve(snap());
    }
    unsub = bus.subscribe(questId, start, (e) => {
      const d = (e.data ?? {}) as Record<string, unknown>;
      if (
        e.action === "DONE" ||
        e.action === "ERROR" ||
        (e.action === "PAUSED" && d.awaitingApproval) ||
        opts.untilSeqAfter !== undefined
      ) {
        // Defer so the caller's snapshot sees state after this event settles.
        queueMicrotask(finish);
      }
    });
    if (finished) unsub();
  });
}

function requireSession(db: DB, questId: string) {
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, questId)).get();
  if (!session) throw new ServiceError("not_found", "quest not found");
  if (session.status === "interrupted") {
    throw new ServiceError("conflict", "quest was interrupted by a server restart", "server_restarted");
  }
  return session;
}

export function controlQuest(
  questId: string,
  action: ControlAction,
  text?: string,
  deps: ServiceDeps = {},
): { ok: true; paused: boolean } {
  const { db } = ctx(deps);
  if (!["pause", "resume", "inject", "cancel"].includes(action)) {
    throw new ServiceError("invalid", "action must be pause|resume|inject|cancel");
  }
  let guidance: string | undefined;
  if (action === "inject") {
    guidance = text?.trim();
    if (!guidance || guidance.length > MAX_GUIDANCE_CHARS) {
      throw new ServiceError("invalid", `text is required (1-${MAX_GUIDANCE_CHARS} chars)`);
    }
  }
  const session = requireSession(db, questId);
  const control = getControl(questId);
  if (action === "cancel") {
    const active = session.status === "running" || session.status === "awaiting_approval";
    if (!active || !control) throw new ServiceError("conflict", `quest is not running (${session.status})`);
    control.abort("cancelled");
    return { ok: true, paused: control.paused };
  }
  if (session.status !== "running" || !control) {
    throw new ServiceError("conflict", `quest is not running (${session.status})`);
  }
  if (action === "pause") control.pause();
  else if (action === "resume") control.resume();
  else control.inject(guidance!);
  return { ok: true, paused: control.paused };
}

export function decideApproval(
  questId: string,
  approved: boolean,
  deps: ServiceDeps = {},
): { ok: true; approved: boolean } {
  const { db } = ctx(deps);
  const session = requireSession(db, questId);
  if (session.status !== "awaiting_approval" || !getControl(questId)?.decide(approved)) {
    throw new ServiceError("conflict", `quest is not awaiting approval (${session.status})`);
  }
  return { ok: true, approved };
}

export interface QuestListItem {
  questId: string;
  query: string;
  status: string;
  source: string;
  totalTokens: number;
  totalCostUsd: number;
  createdAt: number;
}

export function listQuests(
  opts: { limit?: number; status?: string; source?: QuestSource } = {},
  deps: ServiceDeps = {},
): QuestListItem[] {
  const { db } = ctx(deps);
  const limit = Math.min(MAX_LIST, Math.max(1, Math.floor(opts.limit ?? 20)));
  const conds = [];
  if (opts.status) conds.push(eq(schema.sessions.status, opts.status));
  if (opts.source) conds.push(eq(schema.sessions.source, opts.source));
  return db
    .select()
    .from(schema.sessions)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.sessions.createdAt), desc(schema.sessions.id))
    .limit(limit)
    .all()
    .map((s) => ({
      questId: s.id,
      query: s.query,
      status: s.status,
      source: s.source,
      totalTokens: s.totalTokens,
      totalCostUsd: s.totalCostUsd,
      createdAt: s.createdAt,
    }));
}

export { planSummary };
