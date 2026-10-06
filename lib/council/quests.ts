import { eq } from "drizzle-orm";
import { getDb, schema, type DB } from "../db";
import type { OrchestrationPlan } from "../shared";
import { BudgetExceeded, BudgetTracker, CostCapExceeded, costCapFromEnv } from "./budget";
import { getBus, type EventBus } from "./bus";
import { collectChat, OpenRouterClient, type LLMClient } from "./llm";
import { LeadOrchestrator } from "./orchestrator";

export interface QuestDeps {
  db?: DB;
  bus?: EventBus;
  llm?: LLMClient;
}

const g = globalThis as unknown as { __councilLlm?: LLMClient };

/** Override (tests) or lazily create the process-wide LLM client. */
export function setLLMClient(llm: LLMClient | undefined): void {
  g.__councilLlm = llm;
}
export function getLLMClient(): LLMClient {
  return (g.__councilLlm ??= new OpenRouterClient());
}

export const TERMINAL_ACTIONS = ["DONE", "ERROR"] as const;

/**
 * Creates a session, plans it with the Lead Orchestrator, then starts the
 * placeholder run loop in the background. Resolves once the plan exists.
 */
export async function createQuest(
  query: string,
  deps: QuestDeps = {},
): Promise<{ questId: string; plan: OrchestrationPlan; done: Promise<void> }> {
  const db = deps.db ?? getDb();
  const bus = deps.bus ?? getBus();
  const llm = deps.llm ?? getLLMClient();
  const questId = crypto.randomUUID();
  const plan = await new LeadOrchestrator({ llm, idFactory: () => questId }).plan(query);

  db.insert(schema.sessions)
    .values({ id: questId, query, status: "running", createdAt: Date.now() })
    .run();
  db.insert(schema.orchestrationPlans)
    .values({
      sessionId: questId,
      complexity: plan.complexityScore,
      agentMatrix: plan.executionPlan.assignedAgents,
      rounds: plan.executionPlan.maxRounds,
    })
    .run();

  const done = runPlaceholder({ db, bus, llm }, questId, query, plan).catch(() => undefined);
  return { questId, plan, done };
}

/** Minimal run loop: THINKING -> SPEAKING per agent, then DONE. (Debate comes in Phase 2.) */
export async function runPlaceholder(
  d: Required<QuestDeps>,
  questId: string,
  query: string,
  plan: OrchestrationPlan,
): Promise<void> {
  const emit = (
    agentId: string,
    action: "THINKING" | "SPEAKING" | "DONE" | "ERROR",
    tokens = 0,
    data = {},
  ) => d.bus.publish({ questId, round: 1, agentId, action, tokensUsed: tokens, data });
  const budget = new BudgetTracker(plan.budgetCapTokens, costCapFromEnv());
  const MAX_TOKENS = 300;
  let totalCostUsd = 0;
  try {
    // Yield so the caller can subscribe before events fire.
    await new Promise((r) => setTimeout(r, 0));
    for (const agent of plan.executionPlan.assignedAgents) {
      emit(agent.id, "THINKING");
      const models = [agent.model, ...agent.fallbackModels].filter((m): m is string => !!m);
      const messages = [
        {
          role: "system" as const,
          content: `You are the ${agent.role} of a council. Answer briefly.`,
        },
        { role: "user" as const, content: query },
      ];
      const promptEstimate = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
      budget.assertCanSpend(MAX_TOKENS + promptEstimate, agent.id);
      const startedAt = Date.now();
      const { text, reasoning, usage } = await collectChat(
        d.llm.streamChat({ messages, models, maxTokens: MAX_TOKENS }),
      );
      const latencyMs = Date.now() - startedAt;
      const tokens = (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
      const costUsd = usage?.costUsd ?? 0;
      totalCostUsd += costUsd;
      d.db
        .insert(schema.agentMessages)
        .values({
          sessionId: questId,
          round: 1,
          agentId: agent.id,
          actionType: "SPEAKING",
          thoughtLog: reasoning || null,
          visibleMessage: text,
          tokenCount: tokens,
          latencyMs,
        })
        .run();
      d.db
        .update(schema.sessions)
        .set({ totalCostUsd })
        .where(eq(schema.sessions.id, questId))
        .run();
      try {
        budget.record(
          {
            promptTokens: usage?.promptTokens ?? 0,
            completionTokens: usage?.completionTokens ?? 0,
          },
          agent.id,
        );
        budget.recordCost(costUsd, agent.id);
      } finally {
        // Surface what was spent even if recording breached the cap.
        emit(agent.id, "SPEAKING", tokens, {
          message: text,
          costUsd,
          budget: {
            cap: budget.cap,
            used: budget.used,
            remaining: budget.remaining,
            remainingRatio: budget.remainingRatio,
            costUsd: budget.costUsd,
            costCapUsd: budget.costCapUsd,
          },
        });
      }
    }
    emit("lead", "DONE", 0, {
      totalTokens: budget.used,
      totalCostUsd,
    });
    d.db
      .update(schema.sessions)
      .set({ status: "done", totalTokens: budget.used, totalCostUsd })
      .where(eq(schema.sessions.id, questId))
      .run();
  } catch (e) {
    const exceeded = e instanceof BudgetExceeded;
    const costExceeded = e instanceof CostCapExceeded;
    emit(
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
          ? {
              reason: "budget_exceeded",
              cap: e.cap,
              used: budget.used,
              message: e.message,
            }
          : { message: e instanceof Error ? e.message : String(e) },
    );
    d.db
      .update(schema.sessions)
      .set({
        status: costExceeded ? "cost_cap_exceeded" : exceeded ? "budget_exceeded" : "error",
        totalTokens: budget.used,
        totalCostUsd,
      })
      .where(eq(schema.sessions.id, questId))
      .run();
  }
}
