import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, schema } from "../../db";
import type { OrchestrationPlan } from "../../shared";
import { EventBus } from "../bus";
import { MockLLMClient } from "../llm";
import { LEAD_MODELS } from "../roster";
import { runDebate } from "./engine";

function makePlan(maxRounds: number, budgetCapTokens = 30000): OrchestrationPlan {
  return {
    taskId: "t",
    complexityScore: 3,
    budgetCapTokens,
    executionPlan: {
      maxRounds,
      toolsAllowed: [],
      assignedAgents: [
        { id: "wizard-1", role: "wizard", avatar: "wizard", model: "m/a", fallbackModels: ["m/x"] },
        { id: "scout-1", role: "scout", avatar: "scout", model: "m/b", fallbackModels: [] },
      ],
    },
  };
}

async function run(
  plan: OrchestrationPlan,
  llm: MockLLMClient,
  opts?: Parameters<typeof runDebate>[4],
) {
  const db = createDb(":memory:");
  const bus = new EventBus(db);
  db.insert(schema.sessions)
    .values({ id: "q", query: "Q?", status: "running", createdAt: Date.now() })
    .run();
  await runDebate({ db, bus, llm }, "q", "Q?", plan, opts);
  const events = bus.replay("q");
  const rows = db
    .select()
    .from(schema.agentMessages)
    .where(eq(schema.agentMessages.sessionId, "q"))
    .all();
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, "q")).get()!;
  return { events, rows, session };
}

describe("runDebate", () => {
  it("1 round: proposals then synthesis", async () => {
    const llm = new MockLLMClient((p) =>
      p.models[0] === LEAD_MODELS[0] ? "FINAL" : `proposal from ${p.models[0]}`,
    );
    const { events, rows, session } = await run(makePlan(1), llm);
    expect(events.map((e) => `${e.agentId}:${e.action}`)).toEqual([
      "wizard-1:THINKING",
      "wizard-1:SPEAKING",
      "scout-1:THINKING",
      "scout-1:SPEAKING",
      "lead:CONSENSUS",
      "lead:SPEAKING",
      "lead:DONE",
    ]);
    expect(events.every((e) => e.round === 1)).toBe(true);
    const done = events.at(-1)!;
    expect(done.data).toMatchObject({ finalAnswer: "FINAL" });
    expect(done.data.totalTokens).toBeGreaterThan(0);
    expect(session.outcome).toBe("FINAL");
    expect(session.status).toBe("done");
    expect(rows).toHaveLength(3);
    const speaking = events[1].data as Record<string, unknown>;
    expect(speaking).toMatchObject({ message: "proposal from m/a", model: "m/a" });
    expect(speaking.budget).toMatchObject({ remainingRatio: expect.any(Number) });
  });

  it("3 rounds: correct round numbers and peers' latest messages in later rounds", async () => {
    let n = 0;
    const llm = new MockLLMClient(() => `msg${++n}`);
    const { events, rows } = await run(makePlan(3), llm);
    const speaking = events.filter((e) => e.action === "SPEAKING" && e.agentId !== "lead");
    expect(speaking.map((e) => e.round)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(rows.map((r) => r.round)).toEqual([1, 1, 2, 2, 3, 3, 3]);
    expect(events.map((e) => e.id)).toEqual(events.map((_, i) => i + 1));
    // Round 1 prompt has no peers; round 2 wizard sees scout's round-1 message (msg2).
    expect(llm.calls[0].messages[1].content).toBe("Q?");
    const r2wizard = llm.calls[2].messages[1].content;
    expect(r2wizard).toContain("msg2");
    expect(r2wizard).toContain("Your previous position:\nmsg1");
    // Round 3 scout sees wizard round-2 message (msg3), not round-1's (msg1).
    const r3scout = llm.calls[5].messages[1].content;
    expect(r3scout).toContain("msg3");
    expect(r3scout).not.toContain("msg1\n");
    // Synthesis uses lead models and final-round positions.
    expect(llm.calls[6].models).toEqual(LEAD_MODELS);
    expect(llm.calls[6].messages[1].content).toContain("msg5");
    expect(llm.calls[6].messages[1].content).toContain("msg6");
    expect(events.at(-1)!.data.finalAnswer).toBe("msg7");
  });

  it("emits FALLBACK when a fallback model serves the call", async () => {
    const llm = new MockLLMClient("x").enqueue({ text: "hi", modelUsed: "m/x" });
    const { events } = await run(makePlan(1), llm);
    const fb = events.find((e) => e.action === "FALLBACK")!;
    expect(fb).toMatchObject({ agentId: "wizard-1", data: { primary: "m/a", modelUsed: "m/x" } });
    const idx = events.indexOf(fb);
    expect(events[idx - 1].action).toBe("THINKING");
    expect(events[idx + 1].action).toBe("SPEAKING");
  });

  it("ends cleanly on token budget stop mid-debate", async () => {
    const llm = new MockLLMClient({
      text: "big",
      usage: { promptTokens: 700, completionTokens: 300 },
    });
    const { events, session } = await run(makePlan(3, 1500), llm);
    const last = events.at(-1)!;
    expect(last.action).toBe("ERROR");
    expect(last.data).toMatchObject({ reason: "budget_exceeded", cap: 1500 });
    expect(last.round).toBe(1);
    expect(events.some((e) => e.action === "DONE")).toBe(false);
    expect(session.status).toBe("budget_exceeded");
  });

  it("calls checkpoint before every turn and honors a custom prompt builder", async () => {
    const llm = new MockLLMClient("ok");
    const seen: string[] = [];
    await run(makePlan(2), llm, {
      checkpoint: (c) => void seen.push(`${c.round}:${c.agentId}:${c.phase}`),
      buildPrompt: (c) => [{ role: "user", content: `custom r${c.round} ${c.agent.id}` }],
    });
    expect(seen).toEqual([
      "1:wizard-1:agent",
      "1:scout-1:agent",
      "2:wizard-1:agent",
      "2:scout-1:agent",
      "2:lead:synthesis",
    ]);
    expect(llm.calls[3].messages[0].content).toBe("custom r2 scout-1");
  });
});
