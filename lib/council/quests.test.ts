import { describe, expect, it } from "vitest";
import { createDb } from "../db";
import { schema } from "../db";
import { eq } from "drizzle-orm";
import { EventBus } from "./bus";
import { MockLLMClient } from "./llm";
import { createQuest } from "./quests";

const classify = JSON.stringify({ domain: "coding", complexity: 3 });

async function run(usage?: { promptTokens: number; completionTokens: number }) {
  const db = createDb(":memory:");
  const bus = new EventBus(db);
  const llm = new MockLLMClient("hello world").enqueue(classify);
  if (usage) llm.enqueue({ text: "big", usage }, { text: "big", usage });
  const events: Array<{ action: string; data: Record<string, unknown> }> = [];
  const { questId, plan, done } = await createQuest("q", { db, bus, llm });
  await done;
  bus.subscribe(questId, 0, (e) => events.push(e as never));
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, questId)).get();
  return { events, session, plan };
}

describe("quest budget enforcement", () => {
  it("completes within budget and reports budget snapshots", async () => {
    const { events, session } = await run();
    const speaking = events.filter((e) => e.action === "SPEAKING");
    expect(speaking.length).toBeGreaterThan(0);
    const b = speaking[0].data.budget as Record<string, number>;
    expect(b.cap).toBe(30000);
    expect(b.used + b.remaining).toBe(b.cap);
    expect(b.remainingRatio).toBeGreaterThan(0.9);
    expect(events.at(-1)?.action).toBe("DONE");
    expect(session?.status).toBe("done");
  });

  it("stops with budget_exceeded when the cap is hit", async () => {
    const { events, session } = await run({ promptTokens: 20000, completionTokens: 9800 });
    const last = events.at(-1)!;
    expect(last.action).toBe("ERROR");
    expect(last.data).toMatchObject({ reason: "budget_exceeded", cap: 30000 });
    expect(events.filter((e) => e.action === "SPEAKING")).toHaveLength(1);
    expect(session?.status).toBe("budget_exceeded");
  });
});

describe("quest cost persistence", () => {
  it("persists per-call cost and agent_messages rows", async () => {
    const db = createDb(":memory:");
    const bus = new EventBus(db);
    const llm = new MockLLMClient({
      text: "hi there",
      reasoning: "thinking",
      usage: { costUsd: 0.01 },
    }).enqueue(classify);
    const { questId, plan, done } = await createQuest("q", { db, bus, llm });
    await done;
    const events: Array<{ action: string; data: Record<string, unknown> }> = [];
    bus.subscribe(questId, 0, (e) => events.push(e as never));
    const factCheckCalls =
      plan.executionPlan.maxRounds >= 2 || plan.complexityScore >= 4 ? 1 : 0;
    const n = plan.executionPlan.assignedAgents.length * plan.executionPlan.maxRounds + 1 + factCheckCalls;

    const rows = db
      .select()
      .from(schema.agentMessages)
      .where(eq(schema.agentMessages.sessionId, questId))
      .all();
    expect(rows).toHaveLength(n);
    expect(rows[0]).toMatchObject({
      round: 1,
      actionType: "SPEAKING",
      thoughtLog: "thinking",
      visibleMessage: "hi there",
    });
    expect(rows[0].tokenCount).toBeGreaterThan(0);
    expect(rows[0].latencyMs).toBeGreaterThanOrEqual(0);

    const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, questId)).get();
    expect(session?.totalCostUsd).toBeCloseTo(0.01 * n);
    const speaking = events.filter((e) => e.action === "SPEAKING");
    expect(speaking[0].data.costUsd).toBe(0.01);
    expect(events.at(-1)?.data.totalCostUsd).toBeCloseTo(0.01 * n);
  });
});

describe("quest cost cap", () => {
  it("stops with cost_cap_exceeded when spend reaches the cap", async () => {
    const db = createDb(":memory:");
    const bus = new EventBus(db);
    const llm = new MockLLMClient({ text: "hi", usage: { costUsd: 0.3 } }).enqueue(classify);
    const { questId, done } = await createQuest("q", { db, bus, llm });
    await done;
    const events: Array<{ action: string; data: Record<string, unknown> }> = [];
    bus.subscribe(questId, 0, (e) => events.push(e as never));
    const last = events.at(-1)!;
    expect(last.action).toBe("ERROR");
    expect(last.data).toMatchObject({ reason: "cost_cap_exceeded", costCapUsd: 0.5 });
    expect(events.filter((e) => e.action === "SPEAKING")).toHaveLength(2);
    const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, questId)).get();
    expect(session?.status).toBe("cost_cap_exceeded");
    expect(session?.totalCostUsd).toBeCloseTo(0.6);
  });
});
