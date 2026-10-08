import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "../db";
import { EventBus } from "./bus";
import { MockLLMClient, textOf } from "./llm";
import {
  controlQuest,
  decideApproval,
  getQuestSnapshot,
  listQuests,
  ServiceError,
  startQuest,
  waitForQuest,
  type ServiceDeps,
} from "./service";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

let deps: ServiceDeps & { db: DB; bus: EventBus };
let llm: MockLLMClient;

function setup(complexity: number, usage?: { costUsd: number }) {
  const db = createDb(":memory:");
  llm = new MockLLMClient((p) =>
    textOf(p.messages[0].content).includes("Lead Orchestrator")
      ? JSON.stringify({ domain: "coding", complexity })
      : { text: "reply", usage },
  );
  deps = { db, bus: new EventBus(db), llm };
}
const start = (extra: Partial<Parameters<typeof startQuest>[0]> = {}) =>
  startQuest({ query: "q?", source: "web", ...extra }, deps);

beforeEach(() => setup(3));
afterEach(() => vi.unstubAllEnvs());

describe("startQuest", () => {
  it("returns id, plan, status and stores the source", async () => {
    const r = await start({ source: "mcp" });
    expect(r.status).toBe("running");
    expect(r.plan.executionPlan.assignedAgents.length).toBeGreaterThan(0);
    await r.done;
    expect(getQuestSnapshot(r.questId, {}, deps)).toMatchObject({ source: "mcp", status: "done" });
  });

  it("rejects empty queries and bad maxCostUsd", async () => {
    await expect(start({ query: "  " })).rejects.toBeInstanceOf(ServiceError);
    await expect(start({ maxCostUsd: -1 })).rejects.toMatchObject({ code: "invalid" });
  });

  it("maxCostUsd lowers the cap but never raises it", async () => {
    setup(3, { costUsd: 0.02 });
    const low = await start({ maxCostUsd: 0.01 });
    await low.done;
    expect(getQuestSnapshot(low.questId, {}, deps).status).toBe("cost_cap_exceeded");

    vi.stubEnv("MAX_COST_USD_PER_QUEST", "0.01");
    const high = await start({ maxCostUsd: 5 });
    await high.done;
    expect(getQuestSnapshot(high.questId, {}, deps).status).toBe("cost_cap_exceeded");

    vi.unstubAllEnvs();
    const ok = await start({ maxCostUsd: 5 });
    await ok.done;
    expect(getQuestSnapshot(ok.questId, {}, deps).status).toBe("done");
  });
});

describe("approval gate", () => {
  beforeEach(() => setup(5));

  it("waits for approval, then decideApproval(true) runs it", async () => {
    const r = await start();
    expect(r.status).toBe("awaiting_approval");
    const snap = getQuestSnapshot(r.questId, {}, deps);
    expect(snap.awaitingApproval).toBe(true);
    expect(decideApproval(r.questId, true, deps)).toEqual({ ok: true, approved: true });
    await r.done;
    expect(getQuestSnapshot(r.questId, {}, deps).status).toBe("done");
  });

  it("decideApproval(false) cancels; a second decision conflicts", async () => {
    const r = await start();
    decideApproval(r.questId, false, deps);
    await r.done;
    expect(getQuestSnapshot(r.questId, {}, deps).status).toBe("cancelled");
    expect(() => decideApproval(r.questId, true, deps)).toThrowError(/not awaiting approval/);
    expect(() => decideApproval("nope", true, deps)).toThrowError(/not found/);
  });

  it("autoApprove skips the gate", async () => {
    const r = await start({ autoApprove: true });
    expect(r.status).toBe("running");
    await r.done;
    expect(getQuestSnapshot(r.questId, {}, deps).status).toBe("done");
  });

  it("autoApprove has no effect on non-gated quests", async () => {
    setup(3);
    const r = await start({ autoApprove: true });
    expect(r.status).toBe("running");
    await r.done;
  });
});

describe("getQuestSnapshot", () => {
  it("summarizes a finished quest and supports sinceSeq", async () => {
    const r = await start();
    await r.done;
    const snap = getQuestSnapshot(r.questId, {}, deps);
    expect(snap).toMatchObject({
      questId: r.questId,
      query: "q?",
      status: "done",
      source: "web",
      complexity: 3,
      awaitingApproval: false,
      paused: false,
      finalAnswer: "reply",
    });
    expect(snap.agents[0]).toEqual({
      id: expect.any(String),
      role: expect.any(String),
      model: expect.any(String),
    });
    expect(snap.recent.length).toBeLessThanOrEqual(50);
    expect(snap.recent.at(-1)).toMatchObject({ action: "DONE", seq: snap.lastSeq });
    const later = getQuestSnapshot(r.questId, { sinceSeq: snap.lastSeq - 1 }, deps);
    expect(later.recent.map((e) => e.seq)).toEqual([snap.lastSeq]);
    expect(getQuestSnapshot(r.questId, { sinceSeq: snap.lastSeq }, deps).recent).toEqual([]);
  });

  it("caps recent at 50 and truncates SPEAKING messages", async () => {
    const r = await start();
    await r.done;
    for (let i = 0; i < 60; i++) {
      deps.bus.publish({
        questId: r.questId,
        round: 1,
        agentId: "a",
        action: "SPEAKING",
        tokensUsed: 1,
        data: { message: "x".repeat(2000) },
      });
    }
    const snap = getQuestSnapshot(r.questId, {}, deps);
    expect(snap.recent).toHaveLength(50);
    expect(snap.recent.at(-1)!.message!.length).toBeLessThanOrEqual(501);
  });

  it("reports error details and unknown quests", async () => {
    llm.enqueue(JSON.stringify({ domain: "coding", complexity: 3 }), { error: new Error("boom") });
    const r = await start();
    await r.done;
    const snap = getQuestSnapshot(r.questId, {}, deps);
    expect(snap.status).toBe("error");
    expect(snap.error).toContain("boom");
    expect(snap.finalAnswer).toBeUndefined();
    expect(() => getQuestSnapshot("nope", {}, deps)).toThrowError(/not found/);
  });
});

describe("waitForQuest", () => {
  it("times out with the current snapshot while the quest is paused", async () => {
    const r = await start();
    controlQuest(r.questId, "pause", undefined, deps);
    await tick();
    const t0 = Date.now();
    const snap = await waitForQuest(r.questId, { timeoutMs: 80 }, deps);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    expect(snap).toMatchObject({ status: "running", paused: true });
    controlQuest(r.questId, "cancel", undefined, deps);
    await r.done;
  });

  it("resolves as soon as the quest reaches DONE", async () => {
    const r = await start();
    controlQuest(r.questId, "pause", undefined, deps);
    await tick();
    const p = waitForQuest(r.questId, { timeoutMs: 10_000 }, deps);
    controlQuest(r.questId, "resume", undefined, deps);
    const snap = await p;
    expect(snap.status).toBe("done");
    expect(snap.finalAnswer).toBe("reply");
    await r.done;
  });

  it("resolves immediately for finished quests and at the approval wait", async () => {
    const a = await start();
    await a.done;
    expect((await waitForQuest(a.questId, { timeoutMs: 10_000 }, deps)).status).toBe("done");

    setup(5);
    const b = await start();
    const snap = await waitForQuest(b.questId, { timeoutMs: 10_000 }, deps);
    expect(snap.awaitingApproval).toBe(true);
    decideApproval(b.questId, false, deps);
    await b.done;
  });

  it("resolves when approval is requested while waiting", async () => {
    setup(5);
    const b = await start();
    decideApproval(b.questId, true, deps);
    await b.done;
    expect((await waitForQuest(b.questId, {}, deps)).status).toBe("done");
  });

  it("untilSeqAfter resolves on new progress; unknown quest throws", async () => {
    const r = await start();
    controlQuest(r.questId, "pause", undefined, deps);
    await tick();
    const seq = getQuestSnapshot(r.questId, {}, deps).lastSeq;
    const p = waitForQuest(r.questId, { timeoutMs: 10_000, untilSeqAfter: seq }, deps);
    controlQuest(r.questId, "resume", undefined, deps);
    const snap = await p;
    expect(snap.lastSeq).toBeGreaterThan(seq);
    await r.done;
    expect(() => waitForQuest("nope", {}, deps)).toThrowError(/not found/);
  });
});

describe("controlQuest", () => {
  it("pause / inject / resume", async () => {
    const r = await start();
    expect(controlQuest(r.questId, "pause", undefined, deps)).toEqual({ ok: true, paused: true });
    expect(getQuestSnapshot(r.questId, {}, deps).paused).toBe(true);
    controlQuest(r.questId, "inject", "focus on cost", deps);
    expect(() => controlQuest(r.questId, "inject", "  ", deps)).toThrowError(/text is required/);
    expect(controlQuest(r.questId, "resume", undefined, deps).paused).toBe(false);
    await r.done;
    expect(deps.bus.replay(r.questId).some((e) => e.agentId === "user" && e.data.guidance)).toBe(true);
  });

  it("cancel while paused ends with status cancelled and a DONE{cancelled} event", async () => {
    const r = await start();
    controlQuest(r.questId, "pause", undefined, deps);
    await tick();
    controlQuest(r.questId, "cancel", undefined, deps);
    await r.done;
    const snap = getQuestSnapshot(r.questId, {}, deps);
    expect(snap.status).toBe("cancelled");
    const last = deps.bus.replay(r.questId).at(-1)!;
    expect(last.action).toBe("DONE");
    expect(last.data).toMatchObject({ cancelled: true });
    expect(() => controlQuest(r.questId, "cancel", undefined, deps)).toThrowError(/not running/);
  });

  it("cancel while awaiting approval", async () => {
    setup(5);
    const r = await start();
    controlQuest(r.questId, "cancel", undefined, deps);
    await r.done;
    expect(getQuestSnapshot(r.questId, {}, deps).status).toBe("cancelled");
    expect(deps.bus.replay(r.questId).at(-1)!.data).toMatchObject({ cancelled: true, reason: "cancelled" });
  });

  it("rejects unknown quests, bad actions and non-running quests", async () => {
    expect(() => controlQuest("nope", "pause", undefined, deps)).toThrowError(/not found/);
    // @ts-expect-error invalid action
    expect(() => controlQuest("nope", "boom", undefined, deps)).toThrowError(/action/);
    const r = await start();
    await r.done;
    expect(() => controlQuest(r.questId, "pause", undefined, deps)).toThrowError(/not running/);
  });
});

describe("listQuests", () => {
  it("lists newest first with filters and a limit cap", async () => {
    const a = await start({ source: "web" });
    await a.done;
    await tick(5);
    const b = await start({ source: "mcp" });
    await b.done;
    expect(listQuests({}, deps).map((q) => q.questId)).toEqual([b.questId, a.questId]);
    expect(listQuests({ source: "mcp" }, deps).map((q) => q.questId)).toEqual([b.questId]);
    expect(listQuests({ status: "done", source: "web" }, deps)).toHaveLength(1);
    expect(listQuests({ status: "error" }, deps)).toEqual([]);
    expect(listQuests({ limit: 1 }, deps)).toHaveLength(1);
    expect(listQuests({ limit: 999 }, deps).length).toBeLessThanOrEqual(50);
    expect(listQuests({}, deps)[0]).toMatchObject({ source: "mcp", status: "done", query: "q?" });
  });
});

describe("questViewUrl", () => {
  it("builds from PUBLIC_BASE_URL and is undefined when unset", async () => {
    const { questViewUrl } = await import("./service");
    const prev = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    expect(questViewUrl("q1")).toBeUndefined();
    process.env.PUBLIC_BASE_URL = "http://host:3000/";
    expect(questViewUrl("q1")).toBe("http://host:3000/?quest=q1");
    if (prev === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = prev;
  });
});
