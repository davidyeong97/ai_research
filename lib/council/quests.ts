import { getDb, schema, type DB } from "../db";
import type { OrchestrationPlan } from "../shared";
import { getBus, type EventBus } from "./bus";
import { runDebate } from "./debate";
import { OpenRouterClient, type LLMClient } from "./llm";
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

  const done = runDebate({ db, bus, llm }, questId, query, plan).catch(() => undefined);
  return { questId, plan, done };
}
