import { eq } from "drizzle-orm";
import { getDb, schema, type DB } from "../db";
import type { OrchestrationPlan } from "../shared";
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
async function runPlaceholder(
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
  let total = 0;
  try {
    // Yield so the caller can subscribe before events fire.
    await new Promise((r) => setTimeout(r, 0));
    for (const agent of plan.executionPlan.assignedAgents) {
      emit(agent.id, "THINKING");
      const models = [agent.model, ...agent.fallbackModels].filter((m): m is string => !!m);
      const { text, usage } = await collectChat(
        d.llm.streamChat({
          messages: [
            { role: "system", content: `You are the ${agent.role} of a council. Answer briefly.` },
            { role: "user", content: query },
          ],
          models,
          maxTokens: 300,
        }),
      );
      const tokens = (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
      total += tokens;
      emit(agent.id, "SPEAKING", tokens, { message: text });
    }
    emit("lead", "DONE", 0, { totalTokens: total });
    d.db
      .update(schema.sessions)
      .set({ status: "done", totalTokens: total })
      .where(eq(schema.sessions.id, questId))
      .run();
  } catch (e) {
    emit("lead", "ERROR", 0, { message: e instanceof Error ? e.message : String(e) });
    d.db
      .update(schema.sessions)
      .set({ status: "error" })
      .where(eq(schema.sessions.id, questId))
      .run();
  }
}
