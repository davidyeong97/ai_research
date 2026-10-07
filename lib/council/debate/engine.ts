import { eq } from "drizzle-orm";
import type { DB } from "../../db";
import { schema } from "../../db";
import type { OrchestrationPlan } from "../../shared";
import { BudgetExceeded, BudgetTracker, CostCapExceeded, costCapFromEnv } from "../budget";
import type { EventBus } from "../bus";
import { cacheKey, cacheGet, cacheSet, purgeExpired } from "../cache";
import type { ChatMessage, LLMClient, LLMUsage } from "../llm";
import { LEAD_MODELS } from "../roster";
import { sanitizeText } from "./sanitize";
import {
  buildAgentPrompt,
  buildFactCheckPrompt,
  buildSynthesisPrompt,
  type DebateAgent,
  buildSummaryPrompt,
  type HistoryEntry,
  type PromptBuilder,
  type SynthesisPromptBuilder,
} from "./prompts";

export interface DebateDeps {
  db: DB;
  bus: EventBus;
  llm: LLMClient;
}

/** Context passed to the between-turns checkpoint hook. */
export interface CheckpointContext {
  questId: string;
  round: number;
  /** Agent about to speak ("lead" before synthesis). */
  agentId: string;
  phase: "agent" | "synthesis" | "summary" | "factcheck";
  history: readonly HistoryEntry[];
}

export interface DebateOptions {
  /** Hook: build each agent's prompt from history. */
  buildPrompt?: PromptBuilder;
  /** Hook: build the lead's synthesis prompt. */
  buildSynthesis?: SynthesisPromptBuilder;
  /** Hook: awaited before every turn (pause/inject/summarize extension point). */
  checkpoint?: (ctx: CheckpointContext) => Promise<void> | void;
  agentMaxTokens?: number;
  summaryMaxTokens?: number;
  synthesisMaxTokens?: number;
}

const AGENT_MAX_TOKENS = 400;
const SYNTHESIS_MAX_TOKENS = 700;
const SUMMARY_MAX_TOKENS = 500; // ~400-token target plus headroom

export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 3;

export function webSearchMaxResults(): number {
  const n = Number(process.env.WEB_SEARCH_MAX_RESULTS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_WEB_SEARCH_MAX_RESULTS;
}

/** Citations come from the open web: keep http(s) URLs only and sanitize titles. */
function sanitizeCitations(list: { url: string; title?: string }[]) {
  const out: { url: string; title?: string }[] = [];
  for (const c of list) {
    try {
      const u = new URL(c.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      const title = c.title ? sanitizeText(c.title, { maxChars: 200 }) : undefined;
      out.push({ url: u.toString().slice(0, 2000), ...(title ? { title } : {}) });
    } catch {
      /* skip invalid URL */
    }
  }
  return out;
}

export async function runDebate(
  d: DebateDeps,
  questId: string,
  query: string,
  plan: OrchestrationPlan,
  opts: DebateOptions = {},
): Promise<void> {
  const buildPrompt = opts.buildPrompt ?? buildAgentPrompt;
  const buildSynthesis = opts.buildSynthesis ?? buildSynthesisPrompt;
  const checkpoint = opts.checkpoint ?? (() => undefined);
  const agentMax = opts.agentMaxTokens ?? AGENT_MAX_TOKENS;
  const summaryMax = opts.summaryMaxTokens ?? SUMMARY_MAX_TOKENS;
  const synthMax = opts.synthesisMaxTokens ?? SYNTHESIS_MAX_TOKENS;

  const budget = new BudgetTracker(plan.budgetCapTokens, costCapFromEnv());
  const agents: DebateAgent[] = plan.executionPlan.assignedAgents;
  const maxRounds = Math.max(1, plan.executionPlan.maxRounds);
  const searchEnabled = plan.executionPlan.toolsAllowed.includes("web_search");
  const history: HistoryEntry[] = [];
  let totalCostUsd = 0;
  let currentRound = 1;
  let summary: string | undefined;
  let factCheck: string | undefined;

  const emit = (
    round: number,
    agentId: string,
    action: Parameters<EventBus["publish"]>[0]["action"],
    tokens = 0,
    data: Record<string, unknown> = {},
  ) => d.bus.publish({ questId, round, agentId, action, tokensUsed: tokens, data });

  const snapshot = () => ({
    cap: budget.cap,
    used: budget.used,
    remaining: budget.remaining,
    remainingRatio: budget.remainingRatio,
    costUsd: budget.costUsd,
    costCapUsd: budget.costCapUsd,
  });

  /** One LLM call with budget checks, FALLBACK events, persistence and SPEAKING/CONSENSUS output. */
  async function turn(args: {
    round: number;
    agentId: string;
    models: string[];
    messages: ChatMessage[];
    maxTokens: number;
    rowAction: "SPEAKING" | "CONSENSUS" | "SUMMARY" | "FACT_CHECK";
    extraData?: Record<string, unknown>;
    webSearch?: { maxResults: number };
  }): Promise<string> {
    const { round, agentId, models, messages, maxTokens } = args;
    const promptEstimate = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
    budget.assertCanSpend(maxTokens + promptEstimate, agentId);

    let text = "";
    let reasoning = "";
    let usage: LLMUsage | undefined;
    const citations: { url: string; title?: string }[] = [];
    if (args.webSearch) {
      emit(round, agentId, "SEARCHING", 0, { statusMessage: "Searching the web…" });
    }
    const startedAt = Date.now();
    const key = args.webSearch
      ? cacheKey({ tool: "web_search", maxResults: args.webSearch.maxResults, models, messages })
      : undefined;
    const hit = key ? cacheGet(d.db, key) : undefined;
    let cached = false;
    if (hit) {
      cached = true;
      text = hit.text;
      reasoning = hit.reasoning ?? "";
      citations.push(...hit.citations);
    } else {
      for await (const c of d.llm.streamChat({ messages, models, maxTokens, webSearch: args.webSearch })) {
        if (c.type === "text") text += c.delta;
        else if (c.type === "reasoning") reasoning += c.delta;
        else if (c.type === "usage") usage = c.usage;
        else if (c.type === "citations") citations.push(...sanitizeCitations(c.citations));
        else emit(round, agentId, "FALLBACK", 0, { primary: c.primary, modelUsed: c.modelUsed });
      }
      if (key && text) {
        cacheSet(d.db, key, { text, reasoning: reasoning || undefined, citations, model: usage?.modelUsed });
        purgeExpired(d.db);
      }
    }
    const latencyMs = Date.now() - startedAt;
    const tokens = (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
    const costUsd = usage?.costUsd ?? 0;
    totalCostUsd += costUsd;

    d.db
      .insert(schema.agentMessages)
      .values({
        sessionId: questId,
        round,
        agentId,
        actionType: args.rowAction,
        thoughtLog: reasoning || null,
        visibleMessage: text,
        tokenCount: tokens,
        latencyMs,
      })
      .run();
    d.db.update(schema.sessions).set({ totalCostUsd }).where(eq(schema.sessions.id, questId)).run();
    try {
      budget.record(
        { promptTokens: usage?.promptTokens ?? 0, completionTokens: usage?.completionTokens ?? 0 },
        agentId,
      );
      budget.recordCost(costUsd, agentId);
    } finally {
      // Surface what was spent even if recording breached a cap.
      emit(round, agentId, "SPEAKING", tokens, {
        ...args.extraData,
        ...(args.webSearch ? { citations } : {}),
        ...(cached ? { cached: true } : {}),
        message: text,
        costUsd,
        model: usage?.modelUsed ?? (cached ? hit?.model : undefined) ?? models[0],
        budget: snapshot(),
      });
    }
    return text;
  }

  try {
    // Yield so the caller can subscribe before events fire.
    await new Promise((r) => setTimeout(r, 0));

    for (let round = 1; round <= maxRounds; round++) {
      currentRound = round;
      const roundEntries: HistoryEntry[] = [];
      if (round >= 3) {
        // Compact rounds 1..round-1 so prompts don't grow quadratically.
        await checkpoint({ questId, round, agentId: "lead", phase: "summary", history });
        emit(round, "lead", "THINKING", 0, { statusMessage: "Summarizing debate…" });
        summary = await turn({
          round,
          agentId: "lead",
          models: LEAD_MODELS,
          messages: buildSummaryPrompt({
            query,
            previousSummary: summary,
            // Rounds already folded into `summary` are not re-sent.
            entries: history.filter((e) => (summary ? e.round === round - 1 : true)),
            upToRound: round - 1,
          }),
          maxTokens: summaryMax,
          rowAction: "SUMMARY",
          extraData: { summary: true },
        });
      }
      for (const agent of agents) {
        await checkpoint({ questId, round, agentId: agent.id, phase: "agent", history });
        emit(round, agent.id, "THINKING");
        const messages = buildPrompt({
          query,
          agent,
          round,
          maxRounds,
          // Peers in the same round must not see each other's current-round output.
          history,
          agents,
          summary,
          factCheck,
        });
        const models = [agent.model, ...agent.fallbackModels].filter((m): m is string => !!m);
        const text = await turn({
          round,
          agentId: agent.id,
          models,
          messages,
          maxTokens: agentMax,
          rowAction: "SPEAKING",
          webSearch: searchEnabled && (round === 1 || plan.complexityScore >= 5)
            ? { maxResults: webSearchMaxResults() }
            : undefined,
        });
        roundEntries.push({ round, agentId: agent.id, role: agent.role, text });
      }
      history.push(...roundEntries);

      if (round === 1 && (maxRounds >= 2 || plan.complexityScore >= 4) && agents.length > 0) {
        const checker = agents.find((a) => a.role === "scout" || a.avatar === "scout") ?? agents[0];
        await checkpoint({ questId, round, agentId: checker.id, phase: "factcheck", history });
        emit(round, checker.id, "FACT_CHECKING", 0, { statusMessage: "Fact-checking peers' claims…" });
        const claims = roundEntries.filter((e) => e.agentId !== checker.id);
        const verdict = await turn({
          round,
          agentId: checker.id,
          models: [checker.model, ...checker.fallbackModels].filter((m): m is string => !!m),
          messages: buildFactCheckPrompt({
            query,
            agent: checker,
            round,
            entries: claims,
            searchEnabled,
          }),
          maxTokens: agentMax,
          rowAction: "FACT_CHECK",
          extraData: { factCheck: true },
          webSearch: searchEnabled ? { maxResults: webSearchMaxResults() } : undefined,
        });
        factCheck = verdict.trim() || undefined;
      }
    }

    // Lead synthesis.
    currentRound = maxRounds;
    await checkpoint({ questId, round: maxRounds, agentId: "lead", phase: "synthesis", history });
    emit(maxRounds, "lead", "CONSENSUS", 0, { statusMessage: "Synthesizing final answer…" });
    const finalAnswer = await turn({
      round: maxRounds,
      agentId: "lead",
      models: LEAD_MODELS,
      messages: buildSynthesis({ query, maxRounds, history, agents, factCheck }),
      maxTokens: synthMax,
      rowAction: "CONSENSUS",
    });

    d.db
      .update(schema.sessions)
      .set({ status: "done", totalTokens: budget.used, totalCostUsd, outcome: finalAnswer })
      .where(eq(schema.sessions.id, questId))
      .run();
    emit(maxRounds, "lead", "DONE", 0, {
      finalAnswer,
      totalTokens: budget.used,
      totalCostUsd,
    });
  } catch (e) {
    const exceeded = e instanceof BudgetExceeded;
    const costExceeded = e instanceof CostCapExceeded;
    d.db
      .update(schema.sessions)
      .set({
        status: costExceeded ? "cost_cap_exceeded" : exceeded ? "budget_exceeded" : "error",
        totalTokens: budget.used,
        totalCostUsd,
      })
      .where(eq(schema.sessions.id, questId))
      .run();
    emit(
      currentRound,
      "lead",
      "ERROR",
      0,
      costExceeded
        ? {
            reason: "cost_cap_exceeded",
            costCapUsd: e.costCapUsd,
            spentUsd: e.spentUsd,
            message: e.message,
          }
        : exceeded
          ? { reason: "budget_exceeded", cap: e.cap, used: budget.used, message: e.message }
          : { message: e instanceof Error ? e.message : String(e) },
    );
  }
}
