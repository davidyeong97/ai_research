import { textOf, type MessageContent } from "@/lib/council/llm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "@/lib/council/bus";
import { MockLLMClient, type MockResponse } from "@/lib/council/llm";
import { setLLMClient } from "@/lib/council/quests";
import { createDb } from "@/lib/db";
import type { CouncilEvent } from "@/lib/shared";

type G = { __councilDb?: unknown; __councilBus?: unknown };

let tmpDir: string;
let bus: EventBus;
let llm: MockLLMClient;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (body: unknown) =>
  new Request("http://x", { method: "POST", body: JSON.stringify(body) });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const isAgentCall = (p: { messages: { content: MessageContent }[] }) =>
  textOf(p.messages[0].content).includes("council of AI experts debating");
const isSummaryCall = (p: { messages: { content: MessageContent }[] }) =>
  textOf(p.messages[0].content).includes("Summarize the debate");

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await tick(5);
  }
}

function setup(complexity: number, agentResponse?: () => MockResponse | string) {
  const db = createDb(path.join(tmpDir, `${crypto.randomUUID()}.db`));
  bus = new EventBus(db);
  (globalThis as G).__councilDb = db;
  (globalThis as G).__councilBus = bus;
  llm = new MockLLMClient((p) =>
    textOf(p.messages[0].content).includes("Lead Orchestrator")
      ? JSON.stringify({ domain: "coding", complexity })
      : (agentResponse?.() ?? "a council reply"),
  );
  setLLMClient(llm);
}

async function startQuest(query = "How should we design this?") {
  const { POST } = await import("@/app/api/quests/route");
  const res = await POST(new Request("http://x/api/quests", { method: "POST", body: JSON.stringify({ query }) }));
  expect(res.status).toBe(201);
  const { questId, plan } = await res.json();
  return { questId: questId as string, plan };
}
const terminal = (id: string) => bus.replay(id).some((e) => e.action === "DONE" || e.action === "ERROR");
const finished = (id: string) => waitFor(() => terminal(id), "terminal event");

async function control(id: string, body: unknown) {
  const { POST } = await import("@/app/api/quests/[id]/control/route");
  return POST(jsonReq(body), params(id));
}
async function approve(id: string, approved: boolean) {
  const { POST } = await import("@/app/api/quests/[id]/approve/route");
  return POST(jsonReq({ approved }), params(id));
}
async function readSse(res: Response): Promise<{ id: number; event: CouncilEvent }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.includes("data: "))
    .map((b) => ({
      id: Number(/^id: (\d+)$/m.exec(b)![1]),
      event: JSON.parse(/^data: (.*)$/m.exec(b)![1]) as CouncilEvent,
    }));
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-e2e-"));
  // Warm route modules so slow first imports can't race the debate.
  await import("@/app/api/quests/route");
  await import("@/app/api/quests/[id]/stream/route");
  await import("@/app/api/quests/[id]/control/route");
  await import("@/app/api/quests/[id]/approve/route");
});
afterAll(() => {
  setLLMClient(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Phase 2 debate e2e", () => {
  it("complexity 3: runs 2 rounds and ends with DONE containing finalAnswer", async () => {
    setup(3);
    const { questId, plan } = await startQuest();
    expect(plan.requiresApproval).toBeFalsy();
    expect(plan.executionPlan.maxRounds).toBe(2);
    await finished(questId);

    const ev = bus.replay(questId);
    const rounds = new Set(ev.filter((e) => e.action === "SPEAKING").map((e) => e.round));
    expect([...rounds].sort()).toEqual([1, 2]);
    const last = ev.at(-1)!;
    expect(last.action).toBe("DONE");
    expect(typeof last.data.finalAnswer).toBe("string");
    expect(last.data.finalAnswer).toBeTruthy();
    expect(ev.some((e) => e.action === "PAUSED")).toBe(false);
    expect(llm.calls.some(isSummaryCall)).toBe(false);
  });

  it("complexity 5: waits for approval, then 3 rounds with summary before round 3 and SEARCHING events", async () => {
    setup(5);
    const { questId, plan } = await startQuest("A very hard question");
    expect(plan.requiresApproval).toBe(true);
    expect(plan.executionPlan.maxRounds).toBe(3);
    await tick(50);
    expect(bus.replay(questId).map((e) => e.action)).toEqual(["PAUSED"]);
    expect(bus.replay(questId)[0].data.awaitingApproval).toBe(true);
    expect(llm.calls.filter(isAgentCall)).toHaveLength(0);

    expect((await approve(questId, true)).status).toBe(200);
    await finished(questId);

    const ev = bus.replay(questId);
    expect(ev.at(-1)!.action).toBe("DONE");
    expect(ev.at(-1)!.data.finalAnswer).toBeTruthy();
    expect(new Set(ev.filter((e) => e.action === "SPEAKING").map((e) => e.round))).toEqual(new Set([1, 2, 3]));

    const summaryIdx = ev.findIndex((e) => e.data.summary === true);
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(ev[summaryIdx].round).toBe(3);
    const lastRound2 = ev.map((e, i) => (e.round === 2 && e.action === "SPEAKING" ? i : -1)).reduce((a, b) => Math.max(a, b));
    const firstRound3Agent = ev.findIndex((e) => e.round === 3 && e.action === "THINKING" && e.agentId !== "lead");
    expect(summaryIdx).toBeGreaterThan(lastRound2);
    expect(summaryIdx).toBeLessThan(firstRound3Agent);
    expect(llm.calls.filter(isSummaryCall)).toHaveLength(1);

    const searching = ev.filter((e) => e.action === "SEARCHING");
    expect(searching.length).toBeGreaterThan(0);
    expect(searching.every((e) => e.agentId !== "lead")).toBe(true);
  });

  it("complexity 5: rejecting ends cleanly without running the debate", async () => {
    setup(5);
    const { questId } = await startQuest();
    expect((await approve(questId, false)).status).toBe(200);
    await finished(questId);
    expect(bus.replay(questId).at(-1)).toMatchObject({ action: "DONE", data: { cancelled: true } });
    expect(llm.calls.filter(isAgentCall)).toHaveLength(0);
  });

  it("pause -> inject guidance -> resume: guidance appears in next round prompts", async () => {
    setup(3);
    // Slow the first round so we can pause during it.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = llm;
    setLLMClient({
      async *streamChat(p) {
        if (isAgentCall(p) && inner.calls.filter(isAgentCall).length === 0) await gate;
        yield* inner.streamChat(p);
      },
    });

    const { questId, plan } = await startQuest();
    const n = plan.executionPlan.assignedAgents.length;
    await tick(30);
    expect((await control(questId, { action: "pause" })).status).toBe(200);
    expect((await control(questId, { action: "inject", text: "Prioritise latency" })).status).toBe(200);
    release();
    // Round 1 agent 1 finishes, then the checkpoint before agent 2 pauses.
    await waitFor(() => bus.replay(questId).some((e) => e.action === "PAUSED"), "PAUSED");
    await tick(30);
    const callsWhilePaused = inner.calls.filter(isAgentCall).length;
    expect(callsWhilePaused).toBe(1);
    expect(bus.replay(questId).filter((e) => e.agentId === "user")).toHaveLength(0);

    expect((await control(questId, { action: "resume" })).status).toBe(200);
    await finished(questId);

    const ev = bus.replay(questId);
    expect(ev.at(-1)!.action).toBe("DONE");
    expect(ev.filter((e) => e.action === "PAUSED").map((e) => e.data.paused)).toEqual([true, false]);

    const users = ev.filter((e) => e.agentId === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ round: 2, action: "SPEAKING" });
    expect(String(users[0].data.message)).toContain("Prioritise latency");

    const agentCalls = inner.calls.filter(isAgentCall);
    expect(agentCalls).toHaveLength(n * 2);
    const has = (c: (typeof agentCalls)[number]) =>
      textOf(c.messages.at(-1)!.content).includes("Director guidance from the user") &&
      textOf(c.messages.at(-1)!.content).includes("Prioritise latency");
    expect(agentCalls.slice(0, n).some(has)).toBe(false);
    expect(agentCalls.slice(n).every(has)).toBe(true);
  });

  it("budget cap stop ends cleanly with an ERROR event and no further turns", async () => {
    // Each agent reply reports huge usage so the 30k cap is hit during round 1.
    setup(3, () => ({ text: "expensive", usage: { promptTokens: 20_000, completionTokens: 5_000 } }));
    const { questId } = await startQuest();
    await finished(questId);

    const ev = bus.replay(questId);
    const last = ev.at(-1)!;
    expect(last.action).toBe("ERROR");
    expect(last.data.reason).toBe("budget_exceeded");
    expect(ev.filter((e) => e.action === "DONE")).toHaveLength(0);
    expect(ev.filter((e) => e.action === "CONSENSUS")).toHaveLength(0);
    const callsAtEnd = llm.calls.length;
    await tick(50);
    expect(llm.calls.length).toBe(callsAtEnd);

    const { getDb, schema } = await import("@/lib/db");
    const { eq } = await import("drizzle-orm");
    const s = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, questId)).get();
    expect(s?.status).toBe("budget_exceeded");
  });

  it("SSE reconnect with Last-Event-ID replays only missed events", async () => {
    setup(3);
    const { questId } = await startQuest();
    await finished(questId);
    const { GET } = await import("@/app/api/quests/[id]/stream/route");

    const all = await readSse(await GET(new Request("http://x/s"), params(questId)));
    expect(all.map((e) => e.id)).toEqual(all.map((_, i) => i + 1));
    expect(all.at(-1)!.event.action).toBe("DONE");

    const cut = 5;
    const rest = await readSse(
      await GET(new Request("http://x/s", { headers: { "last-event-id": String(cut) } }), params(questId)),
    );
    expect(rest.map((e) => e.id)).toEqual(all.slice(cut).map((e) => e.id));
    expect(rest.every((e) => e.id > cut)).toBe(true);
    expect(rest.map((e) => e.event)).toEqual(all.slice(cut).map((e) => e.event));

    // Fully caught up: nothing is replayed and the stream stays open until aborted.
    const ac = new AbortController();
    const caughtUp = readSse(
      await GET(
        new Request("http://x/s", { headers: { "last-event-id": String(all.length) }, signal: ac.signal }),
        params(questId),
      ),
    );
    await tick(30);
    ac.abort();
    expect(await caughtUp).toHaveLength(0);
  });

});
