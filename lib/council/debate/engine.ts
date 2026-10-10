import { eq } from "drizzle-orm";
import type { DB } from "../../db";
import { schema } from "../../db";
import type { OrchestrationPlan } from "../../shared";
import { QuestAborted } from "../control";
import { BudgetExceeded, BudgetTracker, CostCapExceeded, costCapFromEnv } from "../budget";
import type { EventBus } from "../bus";
import {
  cacheKey,
  cacheGet,
  cacheSet,
  purgeExpired,
  searchCacheGet,
  searchCacheKey,
  searchCacheSet,
} from "../cache";
import { extractJson } from "../json-extract";
import { SearchError, getSearchProvider, searchBackend, searchDepth } from "../search";
import type { SearchResult } from "../search";
import type { ChatMessage, ContentPart, LLMClient, LLMUsage } from "../llm";
import { estimatePromptTokens, hasMedia, supportsPdf, supportsVision } from "../llm";
import { LEAD_MODELS, multimodalLeadModels } from "../roster";
import type { AttachmentContext } from "./attachment-context";
import { debateLimits } from "./limits";
import { sanitizeText } from "./sanitize";
import {
  buildAgentPrompt,
  buildDigestPrompt,
  buildFactCheckPrompt,
  buildSearchQueryPrompt,
  formatSearchContext,
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
  phase: "agent" | "synthesis" | "summary" | "factcheck" | "digest";
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
  digestMaxTokens?: number;
  factCheckMaxTokens?: number;
  /** Extra output tokens for model reasoning, added on top of each visible budget. */
  reasoningMaxTokens?: number;
  /** Quest attachments (untrusted); enables the digest step and media/text prompt inputs. */
  attachments?: AttachmentContext;
  /** Fenced long-term memory block injected into every agent's round-1 prompt only. */
  recalled?: string;
  /** Per-quest USD cap; defaults to MAX_COST_USD_PER_QUEST. Callers may only lower it. */
  costCapUsd?: number;
}

export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 3;

export function webSearchMaxResults(): number {
  const n = Number(process.env.WEB_SEARCH_MAX_RESULTS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_WEB_SEARCH_MAX_RESULTS;
}

function envInt(name: string, def: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : def;
}

/** Search queries planned per web-search turn (env SEARCH_QUERIES_PER_TURN, default 2, max 3). */
export function searchQueriesPerTurn(): number {
  return envInt("SEARCH_QUERIES_PER_TURN", 2, 3);
}

/** Cap on injected search-result characters (env SEARCH_CONTEXT_MAX_CHARS, default 8000). */
export function searchContextMaxChars(): number {
  return envInt("SEARCH_CONTEXT_MAX_CHARS", 8000, 100_000);
}

const SEARCH_RETRY_BACKOFF_MS = 500;

/** Appends text to the last user message (string or multimodal parts). */
function appendToLastUser(messages: ChatMessage[], extra: string): ChatMessage[] {
  const idx = messages.map((m) => m.role).lastIndexOf("user");
  if (idx < 0) return [...messages, { role: "user", content: extra }];
  const m = messages[idx];
  const content: ChatMessage["content"] =
    typeof m.content === "string"
      ? `${m.content}\n\n${extra}`
      : [...m.content, { type: "text", text: extra }];
  return messages.map((x, i) => (i === idx ? { ...x, content } : x));
}

/** Drops image/file parts from messages (text kept). */
function stripMedia(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    typeof m.content === "string"
      ? m
      : { ...m, content: m.content.filter((p) => p.type === "text") },
  );
}

/** Models able to handle every media part in `messages`. */
function mediaCapableModels(models: string[], messages: ChatMessage[]): string[] {
  let image = false;
  let pdf = false;
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const p of m.content) {
      if (p.type === "image") image = true;
      else if (p.type === "file") pdf = true;
    }
  }
  return models.filter((m) => (!image || supportsVision(m)) && (!pdf || supportsPdf(m)));
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

/** One retry with backoff for retryable search errors (429, 5xx, timeouts, network). */
async function searchWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof SearchError) || !e.retryable) throw e;
    await new Promise((r) => setTimeout(r, SEARCH_RETRY_BACKOFF_MS));
    return fn();
  }
}

/** A Tavily search/planning failure that should trigger the OpenRouter plugin fallback. */
class SearchFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchFailure";
  }
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
  const limits = debateLimits();
  const agentMax = opts.agentMaxTokens ?? limits.agent;
  const summaryMax = opts.summaryMaxTokens ?? limits.summary;
  const synthMax = opts.synthesisMaxTokens ?? limits.synthesis;
  const digestMax = opts.digestMaxTokens ?? limits.digest;
  const factCheckMax = opts.factCheckMaxTokens ?? limits.factCheck;
  const reasoningMax = opts.reasoningMaxTokens ?? limits.reasoning;

  const budget = new BudgetTracker(plan.budgetCapTokens, opts.costCapUsd ?? costCapFromEnv());
  const agents: DebateAgent[] = plan.executionPlan.assignedAgents;
  const maxRounds = Math.max(1, plan.executionPlan.maxRounds);
  const searchEnabled = plan.executionPlan.toolsAllowed.includes("web_search");
  const history: HistoryEntry[] = [];
  let totalCostUsd = 0;
  let currentRound = 1;
  let summary: string | undefined;
  let factCheck: string | undefined;
  let digest: string | undefined;
  const att = opts.attachments && opts.attachments.items.length > 0 ? opts.attachments : undefined;

  /** Raw media this agent's model can read (round 1 only, to control cost). */
  const mediaFor = (agent: DebateAgent, round: number): ContentPart[] | undefined => {
    if (!att || round !== 1 || !agent.model) return undefined;
    const model = agent.model;
    const parts = att.media
      .filter((m) => (m.kind === "image" ? supportsVision(model) : supportsPdf(model)))
      .map((m) => m.part);
    return parts.length ? parts : undefined;
  };

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

  /** Accounts search spend in the budget and session total (throws CostCapExceeded at the cap). */
  function recordSearchCost(costUsd: number, agentId: string) {
    if (costUsd <= 0) return;
    totalCostUsd += costUsd;
    d.db.update(schema.sessions).set({ totalCostUsd }).where(eq(schema.sessions.id, questId)).run();
    budget.recordCost(costUsd, agentId);
  }

  /** Plans 1-n queries with a cheap lead model; falls back to the (trimmed) user query. */
  async function planQueries(
    round: number,
    agentId: string,
    agentRole: string,
    claims: readonly HistoryEntry[] | undefined,
  ): Promise<string[]> {
    const maxQueries = searchQueriesPerTurn();
    const fallbackQuery = [query.replace(/\s+/g, " ").trim().slice(0, 400)].filter(Boolean);
    if (maxQueries <= 1) return fallbackQuery;
    const messages = buildSearchQueryPrompt({ query, agentRole, claims, maxQueries });
    const maxTokens = 200;
    if (!budget.canSpend(maxTokens + estimatePromptTokens(messages))) return fallbackQuery;
    let text = "";
    let usage: LLMUsage | undefined;
    try {
      for await (const c of d.llm.streamChat({
        messages,
        models: [LEAD_MODELS[1] ?? LEAD_MODELS[0], LEAD_MODELS[0]],
        maxTokens,
        jsonMode: true,
      })) {
        if (c.type === "text") text += c.delta;
        else if (c.type === "usage") usage = c.usage;
      }
    } catch {
      return fallbackQuery;
    } finally {
      if (usage) {
        const costUsd = usage.costUsd ?? 0;
        totalCostUsd += costUsd;
        d.db
          .update(schema.sessions)
          .set({ totalCostUsd })
          .where(eq(schema.sessions.id, questId))
          .run();
        budget.record(
          { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens },
          agentId,
        );
        budget.recordCost(costUsd, agentId);
      }
    }
    const parsed = extractJson(text, (v) => {
      const q = (v as { queries?: unknown }).queries;
      return Array.isArray(q) ? q : undefined;
    });
    const out: string[] = [];
    for (const q of parsed ?? []) {
      if (typeof q !== "string") continue;
      const t = q.replace(/\s+/g, " ").trim().slice(0, 400);
      if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
      if (out.length >= maxQueries) break;
    }
    void round;
    return out.length ? out : fallbackQuery;
  }

  /** Search-then-answer step: plan queries, search (cached), collect results and cost into `acc`. */
  async function tavilySearch(
    args: {
      round: number;
      agentId: string;
      agentRole?: string;
      claims?: readonly HistoryEntry[];
      webSearch?: { maxResults: number };
    },
    acc: { costUsd: number; queries: string[]; results: SearchResult[] },
  ): Promise<void> {
    const { round, agentId } = args;
    const queries = await planQueries(round, agentId, args.agentRole ?? agentId, args.claims);
    const provider = getSearchProvider();
    const depth = args.claims ? "advanced" : searchDepth();
    const maxResults = args.webSearch?.maxResults ?? webSearchMaxResults();
    for (const q of queries) {
      emit(round, agentId, "SEARCHING", 0, {
        query: q,
        statusMessage: `Searching: ${q}`,
        provider: "tavily",
      });
      const ckey = searchCacheKey({ provider: provider.name, query: q, maxResults, depth });
      let res = searchCacheGet(d.db, ckey);
      if (!res) {
        try {
          res = await searchWithRetry(() => provider.search(q, { maxResults, depth }));
        } catch (e) {
          throw new SearchFailure(e instanceof Error ? e.message : String(e));
        }
        searchCacheSet(d.db, ckey, res);
      }
      acc.queries.push(q);
      acc.results.push(...res.results);
      acc.costUsd += res.costUsd;
      recordSearchCost(res.costUsd, agentId);
    }
  }

  /** One LLM call with budget checks, FALLBACK events, persistence and SPEAKING/CONSENSUS output. */
  async function turn(args: {
    round: number;
    agentId: string;
    models: string[];
    messages: ChatMessage[];
    /** Visible-answer budget; the reasoning budget is added on top for the request. */
    maxTokens: number;
    rowAction: "SPEAKING" | "CONSENSUS" | "SUMMARY" | "FACT_CHECK" | "DIGEST";
    extraData?: Record<string, unknown>;
    /** Marks a web-search turn (Tavily search-then-answer, or OpenRouter's web plugin). */
    webSearch?: { maxResults: number };
    /** Peer claims to verify (fact-check pass): drives query planning and advanced depth. */
    claims?: readonly HistoryEntry[];
    agentRole?: string;
  }): Promise<string> {
    const { round, agentId } = args;
    // Reasoning is billed as output: reserve it separately so it can't starve the answer.
    const maxTokens = args.maxTokens + reasoningMax;
    // Media only goes to models that can read it; with none, strip it (the digest stays in the text).
    let models = args.models;
    let messages = args.messages;
    const mediaCall = hasMedia(messages);
    if (mediaCall) {
      const capable = mediaCapableModels(models, messages);
      if (capable.length > 0) models = capable;
      else messages = stripMedia(messages);
    }
    // Tavily: search first and inject results; on failure fall back to OpenRouter's web plugin.
    let webSearch = args.webSearch;
    let searchTool = "web_search";
    let searchCostUsd = 0;
    let searchQueries: string[] = [];
    let searchCitations: { url: string; title?: string }[] | undefined;
    if (args.webSearch && searchBackend() === "tavily") {
      const acc = { costUsd: 0, queries: [] as string[], results: [] as SearchResult[] };
      try {
        await tavilySearch(args, acc);
        const ctx = formatSearchContext(acc.results, searchContextMaxChars());
        if (ctx.block) messages = appendToLastUser(messages, ctx.block);
        searchCitations = sanitizeCitations(ctx.used);
        webSearch = undefined;
        searchTool = "web_search:tavily";
      } catch (e) {
        if (!(e instanceof SearchFailure)) throw e;
        emit(round, agentId, "FALLBACK", 0, {
          tool: "web_search",
          from: "tavily",
          to: "openrouter",
          reason: e.message,
        });
      }
      searchCostUsd = acc.costUsd;
      searchQueries = acc.queries;
    }
    const promptEstimate = estimatePromptTokens(messages);
    budget.assertCanSpend(maxTokens + promptEstimate, agentId);

    let text = "";
    let reasoning = "";
    let usage: LLMUsage | undefined;
    let truncated = false;
    const citations: { url: string; title?: string }[] = [];
    if (webSearch) {
      emit(round, agentId, "SEARCHING", 0, { statusMessage: "Searching the web…" });
    }
    const startedAt = Date.now();
    // The key covers the final messages, so injected search context is part of it.
    const key = args.webSearch
      ? cacheKey({ tool: searchTool, maxResults: args.webSearch.maxResults, models, messages })
      : undefined;
    const hit = key ? cacheGet(d.db, key) : undefined;
    let cached = false;
    if (hit) {
      cached = true;
      text = hit.text;
      reasoning = hit.reasoning ?? "";
      citations.push(...hit.citations);
    } else {
      if (searchCitations) citations.push(...searchCitations);
      const consume = async (msgs: ChatMessage[], mdls: string[]) => {
        for await (const c of d.llm.streamChat({
          messages: msgs,
          models: mdls,
          maxTokens,
          reasoning: { maxTokens: reasoningMax },
          webSearch,
        })) {
          if (c.type === "text") text += c.delta;
          else if (c.type === "reasoning") reasoning += c.delta;
          else if (c.type === "usage") {
            usage = c.usage;
            truncated = c.usage.finishReason === "length";
          } else if (c.type === "citations") citations.push(...sanitizeCitations(c.citations));
          else emit(round, agentId, "FALLBACK", 0, { primary: c.primary, modelUsed: c.modelUsed });
        }
      };
      try {
        await consume(messages, models);
      } catch (e) {
        // A media call failed before producing output: retry once text-only over the full model chain.
        if (!(hasMedia(messages) && !text)) throw e;
        reasoning = "";
        truncated = false;
        citations.length = 0;
        if (searchCitations) citations.push(...searchCitations);
        await consume(stripMedia(messages), args.models);
      }
      if (key && text) {
        cacheSet(d.db, key, {
          text,
          reasoning: reasoning || undefined,
          citations,
          model: usage?.modelUsed,
        });
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
        ...(searchQueries.length ? { searchQueries, searchCostUsd, searchProvider: "tavily" } : {}),
        ...(cached ? { cached: true } : {}),
        ...(truncated ? { truncated: true } : {}),
        message: text,
        ...(reasoning ? { thought: reasoning } : {}),
        latencyMs,
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

    if (att) {
      await checkpoint({ questId, round: 1, agentId: "lead", phase: "digest", history });
      emit(1, "lead", "THINKING", 0, { statusMessage: "Examining attachments…" });
      const needPdf = att.hasPdf;
      const leadModels = multimodalLeadModels(needPdf);
      const media = att.media
        .filter((m) =>
          m.kind === "image" ? supportsVision(leadModels[0]) : supportsPdf(leadModels[0]),
        )
        .map((m) => m.part);
      digest =
        (
          await turn({
            round: 1,
            agentId: "lead",
            models: leadModels,
            messages: buildDigestPrompt({
              query,
              textBlock: att.textBlock,
              media,
              names: att.items.map((i) => i.filename),
            }),
            maxTokens: digestMax,
            rowAction: "DIGEST",
            extraData: { attachmentDigest: true },
          })
        ).trim() || undefined;
    }

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
          ...(round === 1 && opts.recalled ? { recalled: opts.recalled } : {}),
          attachments: att
            ? { textBlock: att.textBlock, digest, media: mediaFor(agent, round) }
            : undefined,
        });
        const models = [agent.model, ...agent.fallbackModels].filter((m): m is string => !!m);
        const text = await turn({
          round,
          agentId: agent.id,
          models,
          messages,
          maxTokens: agentMax,
          rowAction: "SPEAKING",
          agentRole: agent.role,
          webSearch:
            searchEnabled && (round === 1 || plan.complexityScore >= 5)
              ? { maxResults: webSearchMaxResults() }
              : undefined,
        });
        roundEntries.push({ round, agentId: agent.id, role: agent.role, text });
      }
      history.push(...roundEntries);

      if (round === 1 && (maxRounds >= 2 || plan.complexityScore >= 4) && agents.length > 0) {
        const checker = agents.find((a) => a.role === "scout" || a.avatar === "scout") ?? agents[0];
        await checkpoint({ questId, round, agentId: checker.id, phase: "factcheck", history });
        emit(round, checker.id, "FACT_CHECKING", 0, {
          statusMessage: "Fact-checking peers' claims…",
        });
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
            digest,
          }),
          maxTokens: factCheckMax,
          rowAction: "FACT_CHECK",
          extraData: { factCheck: true },
          webSearch: searchEnabled ? { maxResults: webSearchMaxResults() } : undefined,
          claims,
          agentRole: checker.role,
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
      messages: buildSynthesis({ query, maxRounds, history, agents, factCheck, digest }),
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
    if (e instanceof QuestAborted && e.reason === "cancelled") {
      d.db
        .update(schema.sessions)
        .set({ status: "cancelled", totalTokens: budget.used, totalCostUsd })
        .where(eq(schema.sessions.id, questId))
        .run();
      emit(currentRound, "lead", "DONE", 0, {
        cancelled: true,
        reason: "cancelled",
        totalTokens: budget.used,
        totalCostUsd,
      });
      return;
    }
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
