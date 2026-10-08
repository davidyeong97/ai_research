import { z } from "zod";

export const AVATARS = ["wizard", "scout", "rogue", "knight", "cleric", "bard"] as const;

export const AgentAssignmentSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  avatar: z.string().min(1),
  /** Primary OpenRouter model ID; `fallbackModels` are tried after it. */
  model: z.string().min(1).optional(),
  fallbackModels: z.array(z.string().min(1)).default([]),
});

export const ExecutionPlanSchema = z.object({
  assignedAgents: z.array(AgentAssignmentSchema).min(1),
  maxRounds: z.number().int().min(1),
  toolsAllowed: z.array(z.string().min(1)).default([]),
});

export const OrchestrationPlanSchema = z.object({
  taskId: z.string().min(1),
  complexityScore: z.number().int().min(1).max(5),
  budgetCapTokens: z.number().int().positive(),
  requiresApproval: z.boolean().optional(),
  /** Ids of long-term memories recalled for this quest (optional). */
  recalledMemoryIds: z.array(z.string()).optional(),
  executionPlan: ExecutionPlanSchema,
});

export const COUNCIL_ACTIONS = [
  "THINKING",
  "SEARCHING",
  "SPEAKING",
  "FACT_CHECKING",
  "RECALL",
  "PAUSED",
  "FALLBACK",
  "CONSENSUS",
  "DONE",
  "ERROR",
] as const;

export const CouncilActionSchema = z.enum(COUNCIL_ACTIONS);

/** `id` is a per-quest monotonically increasing integer used as the SSE `id:` / Last-Event-ID. */
export const CouncilEventSchema = z.object({
  id: z.number().int().nonnegative(),
  questId: z.string().min(1),
  timestamp: z.iso.datetime(),
  round: z.number().int().nonnegative(),
  agentId: z.string().min(1),
  action: CouncilActionSchema,
  tokensUsed: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type AgentAssignment = z.infer<typeof AgentAssignmentSchema>;
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;
export type OrchestrationPlan = z.infer<typeof OrchestrationPlanSchema>;
export type CouncilAction = z.infer<typeof CouncilActionSchema>;
export type CouncilEvent = z.infer<typeof CouncilEventSchema>;
