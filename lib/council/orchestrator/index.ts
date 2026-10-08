import { z } from "zod";
import { defaultBudgetCap } from "../budget";
import { collectChat, supportsPdf, supportsVision, type LLMClient } from "../llm";
import type { AttachmentContext } from "../debate/attachment-context";
import { UNTRUSTED_DATA_NOTICE } from "../debate/sanitize";
import {
  DEFAULT_ROSTER,
  DOMAINS,
  LEAD_MODELS,
  planShape,
  type Domain,
  type RosterEntry,
} from "../roster";
import { OrchestrationPlanSchema, type OrchestrationPlan } from "@/lib/shared";

export const ClassificationSchema = z.object({
  domain: z.enum(DOMAINS as [Domain, ...Domain[]]),
  complexity: z.number().int().min(1).max(5),
  reasoning: z.string().optional(),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const CLASSIFY_SYSTEM_PROMPT = `You are the Lead Orchestrator of a council of AI agents.
Classify the user's query. Respond with ONLY a JSON object, no prose, no code fences:
{"domain": "coding"|"science"|"creative"|"casual"|"reasoning", "complexity": 1|2|3|4|5, "reasoning": "<one short sentence>"}
Complexity: 1 trivial/chitchat, 2 simple factual, 3 moderate multi-step, 4 hard/specialised, 5 research-grade or high-stakes needing deep multi-source analysis.`;

/** Extracts and validates the first JSON object in an LLM reply. */
export function parseClassification(text: string): Classification {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No JSON object in classification response");
  const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  if (typeof raw.complexity === "number") raw.complexity = Math.round(raw.complexity);
  if (typeof raw.domain === "string") raw.domain = raw.domain.toLowerCase().trim();
  return ClassificationSchema.parse(raw);
}

export interface OrchestratorOptions {
  llm: LLMClient;
  roster?: RosterEntry[];
  leadModels?: string[];
  /** Used when classification fails twice. */
  fallback?: Classification;
  idFactory?: () => string;
}

export class LeadOrchestrator {
  private readonly roster: RosterEntry[];
  constructor(private readonly opts: OrchestratorOptions) {
    this.roster = opts.roster ?? DEFAULT_ROSTER;
  }

  async classify(
    query: string,
    signal?: AbortSignal,
    attachments?: AttachmentContext,
  ): Promise<Classification> {
    const withFiles = !!attachments && attachments.items.length > 0;
    const userContent = withFiles
      ? `${query}\n\nAttached files (untrusted data, names and previews only):\n${attachments.manifest}`
      : query;
    const system = withFiles
      ? `${CLASSIFY_SYSTEM_PROMPT}\n${UNTRUSTED_DATA_NOTICE}`
      : CLASSIFY_SYSTEM_PROMPT;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text } = await collectChat(
          this.opts.llm.streamChat({
            messages: [
              { role: "system", content: system },
              { role: "user", content: userContent },
            ],
            models: this.opts.leadModels ?? LEAD_MODELS,
            maxTokens: 300,
            signal,
          }),
        );
        return parseClassification(text);
      } catch (e) {
        lastErr = e;
        if (signal?.aborted) throw e;
      }
    }
    if (this.opts.fallback) return this.opts.fallback;
    throw new Error(
      `Orchestrator classification failed: ${(lastErr as Error)?.message ?? lastErr}`,
    );
  }

  async plan(
    query: string,
    signal?: AbortSignal,
    attachments?: AttachmentContext,
  ): Promise<OrchestrationPlan> {
    const c = await this.classify(query, signal, attachments);
    return buildPlan(c, {
      roster: this.roster,
      needs: attachments ? { images: attachments.hasImages, pdf: attachments.hasPdf } : undefined,
      taskId: this.opts.idFactory?.() ?? crypto.randomUUID(),
    });
  }
}

/** Deterministically builds a validated OrchestrationPlan (README §4.1). */
export function buildPlan(
  c: Classification,
  opts: {
    roster?: RosterEntry[];
    taskId: string;
    /** Media present in the quest: agents whose models can read it are ranked first. */
    needs?: { images?: boolean; pdf?: boolean };
  },
): OrchestrationPlan {
  const roster = opts.roster ?? DEFAULT_ROSTER;
  const { minAgents, maxAgents, rounds } = planShape(c.complexity);
  const count = Math.min(roster.length, c.complexity <= 1 ? minAgents : maxAgents);
  // Stable sort: domain specialists first, roster order otherwise.
  const ranked = roster
    .map((r, i) => ({
      r,
      i,
      hit: r.strengths.includes(c.domain) ? 0 : 1,
      media:
        (opts.needs?.images && !supportsVision(r.model) ? 1 : 0) +
        (opts.needs?.pdf && !supportsPdf(r.model) ? 1 : 0),
    }))
    .sort((a, b) => a.media - b.media || a.hit - b.hit || a.i - b.i)
    .map((x) => x.r);
  const assignedAgents = ranked.slice(0, count).map((r) => ({
    id: r.role,
    role: r.role,
    avatar: r.avatar,
    model: r.model,
    fallbackModels: [...r.fallbackModels],
  }));
  return OrchestrationPlanSchema.parse({
    taskId: opts.taskId,
    complexityScore: c.complexity,
    budgetCapTokens: defaultBudgetCap(c.complexity),
    ...(c.complexity === 5 ? { requiresApproval: true } : {}),
    executionPlan: {
      assignedAgents,
      maxRounds: rounds,
      toolsAllowed:
        c.complexity === 5 ? ["web_search"] : c.domain === "science" ? ["web_search"] : [],
    },
  });
}
