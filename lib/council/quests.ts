import { eq } from "drizzle-orm";
import { getDb, schema, type DB } from "../db";
import type { OrchestrationPlan } from "../shared";
import { getBus, type EventBus } from "./bus";
import { createControl, dropControl } from "./control";
import { runDebate } from "./debate";
import { buildAgentPrompt } from "./debate/prompts";
import { costCapFromEnv } from "./budget";
import { OpenRouterClient, type LLMClient } from "./llm";
import { LeadOrchestrator } from "./orchestrator";

export interface QuestDeps {
  db?: DB;
  bus?: EventBus;
  llm?: LLMClient;
  /** Override the 30 min pause/approval timeout (tests). */
  controlTimeoutMs?: number;
  /** Where the quest was started from. Default 'web'. */
  source?: "web" | "mcp";
  /** Per-quest USD cap (already clamped by the caller). Default: env cap. */
  costCapUsd?: number;
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
 * debate in the background. Resolves once the plan exists.
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

  const gated = !!plan.requiresApproval;

  db.insert(schema.sessions)
    .values({
      id: questId,
      query,
      status: gated ? "awaiting_approval" : "running",
      source: deps.source ?? "web",
      createdAt: Date.now(),
    })
    .run();
  db.insert(schema.orchestrationPlans)
    .values({
      sessionId: questId,
      complexity: plan.complexityScore,
      agentMatrix: plan.executionPlan.assignedAgents,
      rounds: plan.executionPlan.maxRounds,
    })
    .run();

  const control = createControl(questId, deps.controlTimeoutMs);
  const run = () =>
    runDebate({ db, bus, llm }, questId, query, plan, {
      checkpoint: control.checkpointFor(bus),
      buildPrompt: control.wrapPromptBuilder(buildAgentPrompt),
      costCapUsd: deps.costCapUsd,
    });

  let flow: Promise<void>;
  if (!gated) {
    flow = run();
  } else {
    const approval = control.awaitApproval();
    bus.publish({
      questId,
      round: 0,
      agentId: "lead",
      action: "PAUSED",
      tokensUsed: 0,
      data: {
        awaitingApproval: true,
        plan: planSummary(plan),
        estimatedMaxTokens: plan.budgetCapTokens,
        estimatedMaxCostUsd: Math.min(deps.costCapUsd ?? Infinity, estimateMaxCostUsd(plan.budgetCapTokens)),
      },
    });
    flow = approval.then(async (r) => {
      if (r === "approved") {
        db.update(schema.sessions).set({ status: "running" }).where(eq(schema.sessions.id, questId)).run();
        return run();
      }
      db.update(schema.sessions)
        .set({ status: "cancelled" })
        .where(eq(schema.sessions.id, questId))
        .run();
      bus.publish({
        questId,
        round: 0,
        agentId: "lead",
        action: "DONE",
        tokensUsed: 0,
        data: { cancelled: true, reason:
            r === "timeout"
              ? control.aborted === "cancelled"
                ? "cancelled"
                : "approval_timeout"
              : "rejected" },
      });
    });
  }
  const done = flow.catch(() => undefined).finally(() => dropControl(questId));
  return { questId, plan, done };
}

/** Rough upper bound: ~$10 per 1M tokens, never above the per-quest cost cap. */
export function estimateMaxCostUsd(tokens: number): number {
  return Math.min(costCapFromEnv(), (tokens / 1_000_000) * 10);
}

export function planSummary(plan: OrchestrationPlan) {
  return {
    complexity: plan.complexityScore,
    rounds: plan.executionPlan.maxRounds,
    tools: plan.executionPlan.toolsAllowed,
    agents: plan.executionPlan.assignedAgents.map((a) => ({
      id: a.id,
      role: a.role,
      model: a.model,
    })),
  };
}
