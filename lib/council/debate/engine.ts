import { eq } from "drizzle-orm";
import type { DB } from "../../db";
import { schema } from "../../db";
import type { OrchestrationPlan } from "../../shared";
import { BudgetExceeded, BudgetTracker, CostCapExceeded, costCapFromEnv } from "../budget";
import type { EventBus } from "../bus";
import type { ChatMessage, LLMClient, LLMUsage } from "../llm";
import { LEAD_MODELS } from "../roster";
import {
  buildAgentPrompt,
  buildSynthesisPrompt,
  type DebateAgent,
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
  phase: "agent" | "synthesis";
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
  synthesisMaxTokens?: number;
}

const AGENT_MAX_TOKENS = 400;
const SYNTHESIS_MAX_TOKENS = 700;

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
  const synthMax = opts.synthesisMaxTokens ?? SYNTHESIS_MAX_TOKENS;

  const budget = new BudgetTracker(plan.budgetCapTokens, costCapFromEnv());
  const agents: DebateAgent[] = plan.executionPlan.assignedAgents;
  const maxRounds = Math.max(1, plan.executionPlan.maxRounds);
  const history: HistoryEntry[] = [];
  let totalCostUsd = 0;
  let currentRound = 1;

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
    rowAction: "SPEAKING" | "CONSENSUS";
  }): Promise<string> {
    const { round, agentId, models, messages, maxTokens } = args;
    const promptEstimate = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
    budget.assertCanSpend(maxTokens + promptEstimate, agentId);

    let text = "";
    let reasoning = "";
    let usage: LLMUsage | undefined;
    const startedAt = Date.now();
    for await (const c of d.llm.streamChat({ messages, models, maxTokens })) {
      if (c.type === "text") text += c.delta;
      else if (c.type === "reasoning") reasoning += c.delta;
      else if (c.type === "usage") usage = c.usage;
      else emit(round, agentId, "FALLBACK", 0, { primary: c.primary, modelUsed: c.modelUsed });
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
        message: text,
        costUsd,
        model: usage?.modelUsed ?? models[0],
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
        });
        const models = [agent.model, ...agent.fallbackModels].filter((m): m is string => !!m);
        const text = await turn({
          round,
          agentId: agent.id,
          models,
          messages,
          maxTokens: agentMax,
          rowAction: "SPEAKING",
        });
        roundEntries.push({ round, agentId: agent.id, role: agent.role, text });
      }
      history.push(...roundEntries);
    }

    // Lead synthesis.
    currentRound = maxRounds;
    await checkpoint({ questId, round: maxRounds, agentId: "lead", phase: "synthesis", history });
    emit(maxRounds, "lead", "CONSENSUS", 0, { statusMessage: "Synthesizing final answer…" });
    const finalAnswer = await turn({
      round: maxRounds,
      agentId: "lead",
      models: LEAD_MODELS,
      messages: buildSynthesis({ query, maxRounds, history, agents }),
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
