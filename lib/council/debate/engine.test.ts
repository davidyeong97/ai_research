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
    expect(rows.map((r) => r.round)).toEqual([1, 1, 2, 2, 3, 3, 3, 3]);
    expect(events.map((e) => e.id)).toEqual(events.map((_, i) => i + 1));
    // Round 1 prompt has no peers; round 2 wizard sees scout's round-1 message (msg2).
    expect(llm.calls[0].messages[1].content).toBe("Q?");
    const r2wizard = llm.calls[2].messages[1].content;
    expect(r2wizard).toContain("msg2");
    expect(r2wizard).toMatch(/Your previous position:\n<peer_message[^>]*>\nmsg1\n<\/peer_message>/);
    // Call 4 is the lead's summary; round 3 scout sees wizard round-2 message (msg3), not round-1's (msg1).
    const r3scout = llm.calls[6].messages[1].content;
    expect(r3scout).toContain("msg3");
    expect(r3scout).not.toContain("msg1\n");
    // Synthesis uses lead models and final-round positions.
    expect(llm.calls[7].models).toEqual(LEAD_MODELS);
    expect(llm.calls[7].messages[1].content).toContain("msg6");
    expect(llm.calls[7].messages[1].content).toContain("msg7");
    expect(events.at(-1)!.data.finalAnswer).toBe("msg8");
  });

  it("summarizes before round 3+: prompts get summary + previous round only", async () => {
    let n = 0;
    const llm: MockLLMClient = new MockLLMClient((p): string => {
      const sys = p.messages[0].content;
      if (sys.includes("Summarize the debate")) return "SUMMARY-TEXT";
      return `R${p.messages.length}-${++n}-UNIQUE`;
    });
    const plan = makePlan(4);
    const { events, rows } = await run(plan, llm);
    const summaryCalls = llm.calls.filter((c) =>
      c.messages[0].content.includes("Summarize the debate"),
    );
    expect(summaryCalls).toHaveLength(2); // before rounds 3 and 4
    expect(summaryCalls[0].models).toEqual(LEAD_MODELS);
    // Round-3 summary input contains rounds 1-2 transcript.
    expect(summaryCalls[0].messages[1].content).toContain('round="1"');
    // Round-4 summary builds on previous summary + only round 3.
    expect(summaryCalls[1].messages[1].content).toContain("SUMMARY-TEXT");
    expect(summaryCalls[1].messages[1].content).not.toContain('round="1"');
    expect(summaryCalls[1].messages[1].content).not.toContain('round="2"');

    const idx = llm.calls.indexOf(summaryCalls[0]);
    const round1Text = `R2-1-UNIQUE`; // wizard round-1 output (first call)
    expect(llm.calls[0].messages.length).toBe(2);
    const r3 = llm.calls[idx + 1].messages[1].content;
    expect(r3).toContain("SUMMARY-TEXT");
    expect(r3).not.toContain(round1Text);
    expect(r3).not.toContain("round 1]");

    const thinking = events.find((e) => e.agentId === "lead" && e.action === "THINKING")!;
    expect(thinking.round).toBe(3);
    expect(thinking.data).toMatchObject({ statusMessage: "Summarizing debate…" });
    expect(rows.filter((r) => r.actionType === "SUMMARY").map((r) => r.round)).toEqual([3, 4]);
    expect(events.at(-1)!.action).toBe("DONE");
  });

  it("counts summary spend against the token budget", async () => {
    const llm = new MockLLMClient({
      text: "x",
      usage: { promptTokens: 10, completionTokens: 10 },
    });
    const { events, session } = await run(makePlan(3), llm);
    // 2 agents*2 rounds + summary + 2 round-3 agents + synthesis = 8 calls * 20
    expect(events.at(-1)!.data.totalTokens).toBe(160);
    expect(session.totalTokens).toBe(160);
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
