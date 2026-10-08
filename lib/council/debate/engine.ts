import { eq } from "drizzle-orm";
import type { DB } from "../../db";
import { schema } from "../../db";
import type { OrchestrationPlan } from "../../shared";
import { QuestAborted } from "../control";
import { BudgetExceeded, BudgetTracker, CostCapExceeded, costCapFromEnv } from "../budget";
import type { EventBus } from "../bus";
import { cacheKey, cacheGet, cacheSet, purgeExpired } from "../cache";
import type { ChatMessage, ContentPart, LLMClient, LLMUsage } from "../llm";
import { estimatePromptTokens, hasMedia, supportsPdf, supportsVision } from "../llm";
import { LEAD_MODELS, multimodalLeadModels } from "../roster";
import type { AttachmentContext } from "./attachment-context";
import { sanitizeText } from "./sanitize";
import {
  buildAgentPrompt,
  buildDigestPrompt,
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
  /** Per-quest USD cap; defaults to MAX_COST_USD_PER_QUEST. Callers may only lower it. */
  costCapUsd?: number;
  digestMaxTokens?: number;
  /** Quest attachments (untrusted); enables the digest step and media/text prompt inputs. */
  attachments?: AttachmentContext;
  /** Fenced long-term memory block injected into every agent's round-1 prompt only. */
  recalled?: string;
}

const AGENT_MAX_TOKENS = 400;
const SYNTHESIS_MAX_TOKENS = 700;
const DIGEST_MAX_TOKENS = 500;
const SUMMARY_MAX_TOKENS = 500; // ~400-token target plus headroom

export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 3;

export function webSearchMaxResults(): number {
  const n = Number(process.env.WEB_SEARCH_MAX_RESULTS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_WEB_SEARCH_MAX_RESULTS;
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

  /** One LLM call with budget checks, FALLBACK events, persistence and SPEAKING/CONSENSUS output. */
  async function turn(args: {
    round: number;
    agentId: string;
    models: string[];
    messages: ChatMessage[];
    maxTokens: number;
    rowAction: "SPEAKING" | "CONSENSUS" | "SUMMARY" | "FACT_CHECK" | "DIGEST";
    extraData?: Record<string, unknown>;
    webSearch?: { maxResults: number };
  }): Promise<string> {
    const { round, agentId, maxTokens } = args;
    // Media only goes to models that can read it; with none, strip it (the digest stays in the text).
    let models = args.models;
    let messages = args.messages;
    const mediaCall = hasMedia(messages);
    if (mediaCall) {
      const capable = mediaCapableModels(models, messages);
      if (capable.length > 0) models = capable;
      else messages = stripMedia(messages);
    }
    const promptEstimate = estimatePromptTokens(messages);
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
      const consume = async (msgs: ChatMessage[], mdls: string[]) => {
        for await (const c of d.llm.streamChat({
          messages: msgs,
          models: mdls,
          maxTokens,
          webSearch: args.webSearch,
        })) {
          if (c.type === "text") text += c.delta;
          else if (c.type === "reasoning") reasoning += c.delta;
          else if (c.type === "usage") usage = c.usage;
          else if (c.type === "citations") citations.push(...sanitizeCitations(c.citations));
          else emit(round, agentId, "FALLBACK", 0, { primary: c.primary, modelUsed: c.modelUsed });
        }
      };
      try {
        await consume(messages, models);
      } catch (e) {
        // A media call failed before producing output: retry once text-only over the full model chain.
        if (!(hasMedia(messages) && !text)) throw e;
        reasoning = "";
        citations.length = 0;
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
            maxTokens: opts.digestMaxTokens ?? DIGEST_MAX_TOKENS,
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
