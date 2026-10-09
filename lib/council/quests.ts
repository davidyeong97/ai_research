import { eq } from "drizzle-orm";
import { getDb, schema, type DB } from "../db";
import type { OrchestrationPlan } from "../shared";
import { getBus, type EventBus } from "./bus";
import { createControl, dropControl } from "./control";
import { runDebate } from "./debate";
import { buildAgentPrompt } from "./debate/prompts";
import { costCapFromEnv } from "./budget";
import { OpenRouterClient, type LLMClient } from "./llm";
import { extractMemories } from "./memory/extract";
import { prepareRecall } from "./memory/recall";
import { touchUsed } from "./memory/store";
import { LeadOrchestrator, SAFE_CLASSIFICATION } from "./orchestrator";
import { UploadError, linkToSession, resolveUnlinkedAttachments } from "./attachments";
import { buildAttachmentContext, type AttachmentMeta } from "./debate/attachment-context";

export const DEFAULT_ATTACHMENT_QUERY = "Analyze the attached file(s).";

export interface CreateQuestOptions {
  attachmentIds?: string[];
  /** false opts this quest out of long-term memory extraction. Default true. */
  remember?: boolean;
}

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
  options: CreateQuestOptions = {},
): Promise<{
  questId: string;
  plan: OrchestrationPlan;
  done: Promise<void>;
  query: string;
  attachments: AttachmentMeta[];
}> {
  const db = deps.db ?? getDb();
  const bus = deps.bus ?? getBus();
  const llm = deps.llm ?? getLLMClient();
  const questId = crypto.randomUUID();
  const records = resolveUnlinkedAttachments(options.attachmentIds ?? [], db);
  query = query.trim();
  if (!query) {
    if (records.length === 0) throw new UploadError(400, "query is required");
    query = DEFAULT_ATTACHMENT_QUERY;
  }
  const attachmentCtx = records.length ? buildAttachmentContext(records, db) : undefined;
  const attachments = attachmentCtx?.items ?? [];
  const recall = await prepareRecall(query, { db, llm });
  const plan = await new LeadOrchestrator({
    llm,
    idFactory: () => questId,
    fallback: SAFE_CLASSIFICATION,
  }).plan(
    query,
    undefined,
    attachmentCtx,
    recall ? { block: recall.block, ids: recall.ids } : undefined,
  );

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
  if (records.length) {
    linkToSession(
      records.map((r) => r.id),
      questId,
      db,
    );
    bus.publish({
      questId,
      round: 0,
      agentId: "user",
      action: "SPEAKING",
      tokensUsed: 0,
      data: { userQuery: true, message: query, attachments: attachments.map(brief) },
    });
  }

  if (recall) {
    try {
      touchUsed(recall.ids, { db });
    } catch (err) {
      console.warn("[memory] touchUsed failed:", String(err));
    }
    bus.publish({
      questId,
      round: 0,
      agentId: "lead",
      action: "RECALL",
      tokensUsed: 0,
      data: {
        count: recall.ids.length,
        ids: recall.ids,
        chars: recall.chars,
        preview: recall.preview,
        kinds: recall.memories.map((m) => m.kind),
        block: recall.block,
      },
    });
  }

  const control = createControl(questId, deps.controlTimeoutMs);
  const run = () =>
    runDebate({ db, bus, llm }, questId, query, plan, {
      attachments: attachmentCtx,
      recalled: recall?.block,
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
        ...(attachments.length ? { attachments: attachments.map(brief) } : {}),
        estimatedMaxTokens: plan.budgetCapTokens,
        estimatedMaxCostUsd: Math.min(
          deps.costCapUsd ?? Infinity,
          estimateMaxCostUsd(plan.budgetCapTokens),
        ),
      },
    });
    flow = approval.then(async (r) => {
      if (r === "approved") {
        db.update(schema.sessions)
          .set({ status: "running" })
          .where(eq(schema.sessions.id, questId))
          .run();
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
        data: {
          cancelled: true,
          reason:
            r === "timeout"
              ? control.aborted === "cancelled"
                ? "cancelled"
                : "approval_timeout"
              : "rejected",
        },
      });
    });
  }
  const done = flow
    .catch(() => undefined)
    // Separate post-quest step: only extracts when the session ended "done"; never throws.
    .then(() => extractMemories(questId, { db, llm }, { remember: options.remember }))
    .then(() => undefined)
    .finally(() => dropControl(questId));
  return { questId, plan, done, query, attachments };
}

const brief = (a: AttachmentMeta) => ({ id: a.id, filename: a.filename, kind: a.kind });

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
