import { describe, expect, it } from "vitest";
import {
  COUNCIL_ACTIONS,
  CouncilEventSchema,
  OrchestrationPlanSchema,
  type CouncilEvent,
} from "./schemas";

const plan = {
  taskId: "task_98234",
  complexityScore: 4,
  budgetCapTokens: 35000,
  executionPlan: {
    assignedAgents: [
      {
        id: "claude-3-7-sonnet",
        role: "Architect",
        avatar: "wizard",
        fallbackModels: ["google/gemini-pro"],
      },
    ],
    maxRounds: 2,
    toolsAllowed: ["web_search"],
  },
};

const event: CouncilEvent = {
  id: 1,
  questId: "q1",
  timestamp: "2026-10-06T10:00:00Z",
  round: 1,
  agentId: "gemini-2-5-pro",
  action: "SEARCHING",
  tokensUsed: 340,
  data: { query: "x", statusMessage: "Searching" },
};

describe("OrchestrationPlanSchema", () => {
  it("accepts a valid plan", () => {
    expect(OrchestrationPlanSchema.safeParse(plan).success).toBe(true);
  });
  it("defaults fallbackModels and toolsAllowed", () => {
    const p = {
      ...plan,
      executionPlan: {
        assignedAgents: [{ id: "a", role: "r", avatar: "wizard" }],
        maxRounds: 1,
      },
    };
    const r = OrchestrationPlanSchema.parse(p);
    expect(r.executionPlan.assignedAgents[0].fallbackModels).toEqual([]);
    expect(r.executionPlan.toolsAllowed).toEqual([]);
  });
  it.each([0, 6, 2.5])("rejects complexityScore %s", (n) => {
    expect(OrchestrationPlanSchema.safeParse({ ...plan, complexityScore: n }).success).toBe(false);
  });
  it("rejects non-positive budget", () => {
    expect(OrchestrationPlanSchema.safeParse({ ...plan, budgetCapTokens: 0 }).success).toBe(false);
  });
  it("rejects empty agents and missing fields", () => {
    expect(
      OrchestrationPlanSchema.safeParse({
        ...plan,
        executionPlan: { ...plan.executionPlan, assignedAgents: [] },
      }).success,
    ).toBe(false);
    const rest: Record<string, unknown> = { ...plan };
    delete rest.taskId;
    expect(OrchestrationPlanSchema.safeParse(rest).success).toBe(false);
  });
});

describe("CouncilEventSchema", () => {
  it("accepts a valid event", () => {
    expect(CouncilEventSchema.parse(event)).toEqual(event);
  });
  it("accepts every action", () => {
    for (const action of COUNCIL_ACTIONS) {
      expect(CouncilEventSchema.safeParse({ ...event, action }).success).toBe(true);
    }
  });
  it("includes RECALL", () => {
    expect(COUNCIL_ACTIONS).toContain("RECALL");
  });
  it("rejects unknown action", () => {
    expect(CouncilEventSchema.safeParse({ ...event, action: "DANCING" }).success).toBe(false);
  });
  it("rejects bad id, timestamp, tokens", () => {
    expect(CouncilEventSchema.safeParse({ ...event, id: 1.5 }).success).toBe(false);
    expect(CouncilEventSchema.safeParse({ ...event, id: -1 }).success).toBe(false);
    expect(CouncilEventSchema.safeParse({ ...event, timestamp: "yesterday" }).success).toBe(false);
    expect(CouncilEventSchema.safeParse({ ...event, tokensUsed: -5 }).success).toBe(false);
  });
  it("defaults data to {} and rejects missing questId", () => {
    const noData: Record<string, unknown> = { ...event };
    delete noData.data;
    expect(CouncilEventSchema.parse(noData).data).toEqual({});
    const noQuest: Record<string, unknown> = { ...event };
    delete noQuest.questId;
    expect(CouncilEventSchema.safeParse(noQuest).success).toBe(false);
  });
});
