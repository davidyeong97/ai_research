import { textOf, type MessageContent } from "@/lib/council/llm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { POST as login, resetLoginLimiter } from "@/app/api/login/route";
import { EventBus } from "@/lib/council/bus";
import { MockLLMClient, type MockResponse } from "@/lib/council/llm";
import { setLLMClient } from "@/lib/council/quests";
import { dropControl } from "@/lib/council/control";
import { recoverStrandedQuests } from "@/lib/council/recovery";
import { createDb } from "@/lib/db";
import type { CouncilEvent } from "@/lib/shared";

type G = { __councilDb?: unknown; __councilBus?: unknown };
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> | Response;

const PASSWORD = "hunter2";
let tmpDir: string;
let dbPath: string;
let bus: EventBus;
let llm: MockLLMClient;
let cookie: string;
const origPw = process.env.APP_PASSWORD;
const origCost = process.env.MAX_COST_USD_PER_QUEST;

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const isAgentCall = (p: { messages: { content: MessageContent }[] }) =>
  textOf(p.messages[0].content).includes("council of AI experts debating");

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await tick(5);
  }
}

function setup(opts: { complexity: number; domain?: string; reply?: () => MockResponse | string; db?: string }) {
  dbPath = opts.db ?? path.join(tmpDir, `${crypto.randomUUID()}.db`);
  const db = createDb(dbPath);
  bus = new EventBus(db);
  (globalThis as G).__councilDb = db;
  (globalThis as G).__councilBus = bus;
  llm = new MockLLMClient((p) =>
    textOf(p.messages[0].content).includes("Lead Orchestrator")
      ? JSON.stringify({ domain: opts.domain ?? "coding", complexity: opts.complexity })
      : (opts.reply?.() ?? "a council reply"),
  );
  setLLMClient(llm);
}

/** Calls a route handler through the auth proxy with the session cookie, like a real request. */
async function api(method: string, url: string, handler: Handler, id = "x", body?: unknown, withCookie = true) {
  const headers: Record<string, string> = withCookie ? { cookie } : {};
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
  const gate = await proxy(new NextRequest(`http://localhost${url}`, init));
  if (gate.headers.get("x-middleware-next") !== "1") return gate;
  return handler(new Request(`http://localhost${url}`, init), { params: Promise.resolve({ id }) });
}

const routes = {
  quests: () => import("@/app/api/quests/route"),
  stream: () => import("@/app/api/quests/[id]/stream/route"),
  control: () => import("@/app/api/quests/[id]/control/route"),
  approve: () => import("@/app/api/quests/[id]/approve/route"),
  exp: () => import("@/app/api/quests/[id]/export/route"),
};

async function startQuest(query: string) {
  const { POST } = await routes.quests();
  const res = await api("POST", "/api/quests", POST as Handler, "x", { query });
  expect(res.status).toBe(201);
  return (await res.json()) as { questId: string; plan: { requiresApproval?: boolean; executionPlan: { maxRounds: number; assignedAgents: unknown[] } } };
}
async function stream(id: string, lastEventId?: number) {
  const { GET } = await routes.stream();
  const url = `/api/quests/${id}/stream${lastEventId ? `?lastEventId=${lastEventId}` : ""}`;
  const res = await api("GET", url, GET as Handler, id);
  expect(res.status).toBe(200);
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.includes("data: "))
    .map((b) => JSON.parse(/^data: (.*)$/m.exec(b)![1]) as CouncilEvent);
}
async function control(id: string, body: unknown) {
  const { POST } = await routes.control();
  return api("POST", `/api/quests/${id}/control`, POST as Handler, id, body);
}
async function approve(id: string, approved: boolean) {
  const { POST } = await routes.approve();
  return api("POST", `/api/quests/${id}/approve`, POST as Handler, id, { approved });
}
async function exportQuest(id: string, format?: string) {
  const { GET } = await routes.exp();
  return api("GET", `/api/quests/${id}/export${format ? `?format=${format}` : ""}`, GET as Handler, id);
}
const finished = (id: string) =>
  waitFor(() => bus.replay(id).some((e) => e.action === "DONE" || e.action === "ERROR"), "terminal event");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-full-"));
  process.env.APP_PASSWORD = PASSWORD;
  resetLoginLimiter();
  // Warm route modules so slow first imports can't race the debate.
  await Promise.all(Object.values(routes).map((r) => r()));
});
afterAll(() => {
  setLLMClient(undefined);
  if (origPw === undefined) delete process.env.APP_PASSWORD;
  else process.env.APP_PASSWORD = origPw;
  if (origCost === undefined) delete process.env.MAX_COST_USD_PER_QUEST;
  else process.env.MAX_COST_USD_PER_QUEST = origCost;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  delete process.env.MAX_COST_USD_PER_QUEST;
});

describe("full quest flow (mock LLM)", () => {
  it("login sets a session cookie; API is 401 without it", async () => {
    setup({ complexity: 3 });
    const bad = await login(
      new Request("http://localhost/api/login", { method: "POST", body: JSON.stringify({ password: "nope" }) }),
    );
    expect(bad.status).toBe(401);
    const ok = await login(
      new Request("http://localhost/api/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }) }),
    );
    expect(ok.status).toBe(200);
    cookie = ok.headers.get("set-cookie")!.split(";")[0];

    const { POST } = await routes.quests();
    const anon = await api("POST", "/api/quests", POST as Handler, "x", { query: "hi" }, false);
    expect(anon.status).toBe(401);
  });

  it("multi-round debate with fact-check streams until DONE, then exports md and json", async () => {
    setup({ complexity: 3 });
    const { questId, plan } = await startQuest("What is the best sorting algorithm?");
    expect(plan.executionPlan.maxRounds).toBe(2);
    await finished(questId);

    const events = await stream(questId);
    const rounds = new Set(events.filter((e) => e.action === "SPEAKING").map((e) => e.round));
    expect([...rounds].sort()).toEqual([1, 2]);
    const fc = events.filter((e) => e.action === "FACT_CHECKING");
    expect(fc).toHaveLength(1);
    expect(fc[0].round).toBe(1);
    expect(events.at(-1)!.action).toBe("DONE");
    expect(events.at(-1)!.data.finalAnswer).toBeTruthy();

    // Resuming from a Last-Event-ID replays only the tail.
    const tail = await stream(questId, 3);
    expect(tail).toHaveLength(events.length - 3);

    const md = await exportQuest(questId);
    expect(md.status).toBe(200);
    expect(md.headers.get("content-disposition")).toContain(`council-${questId}.md`);
    const text = await md.text();
    expect(text).toContain("# What is the best sorting algorithm?");
    expect(text).toContain("## Final answer");

    const js = await exportQuest(questId, "json");
    expect(js.status).toBe(200);
    const body = await js.json();
    expect(body.session.id).toBe(questId);
    expect(body.events.at(-1).action).toBe("DONE");
    expect(body.agentMessages.length).toBeGreaterThan(0);
    expect((await exportQuest(questId, "xml")).status).toBe(400);
  });

  it("a repeated search-enabled quest is served from the tool cache", async () => {
    setup({ complexity: 3, domain: "science" });
    const first = await startQuest("Explain photosynthesis");
    await finished(first.questId);
    const e1 = bus.replay(first.questId);
    expect(e1.filter((e) => e.action === "SEARCHING").length).toBeGreaterThan(0);
    expect(e1.some((e) => e.data.cached === true)).toBe(false);
    const searchCalls = llm.calls.filter((c) => c.webSearch).length;
    expect(searchCalls).toBeGreaterThan(0);

    const second = await startQuest("Explain photosynthesis");
    await finished(second.questId);
    const e2 = bus.replay(second.questId);
    expect(e2.at(-1)!.action).toBe("DONE");
    expect(e2.some((e) => e.action === "SPEAKING" && e.data.cached === true)).toBe(true);
    // No new search-backed LLM calls were made for the repeat.
    expect(llm.calls.filter((c) => c.webSearch)).toHaveLength(searchCalls);
  });

  it("pause / inject / resume via /control", async () => {
    setup({ complexity: 3 });
    // Hold the first agent call so pause/inject land while the debate is in flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = llm;
    setLLMClient({
      async *streamChat(p) {
        if (isAgentCall(p) && inner.calls.filter(isAgentCall).length === 0) await gate;
        yield* inner.streamChat(p);
      },
    });
    const { questId } = await startQuest("Control me");
    await tick(30);
    expect((await control(questId, { action: "pause" })).status).toBe(200);
    expect((await control(questId, { action: "inject", text: "Focus on latency" })).status).toBe(200);
    release();
    await waitFor(() => bus.replay(questId).some((e) => e.action === "PAUSED"), "PAUSED");
    expect((await control(questId, { action: "resume" })).status).toBe(200);
    await finished(questId);

    const ev = bus.replay(questId);
    expect(ev.at(-1)!.action).toBe("DONE");
    expect(ev.filter((e) => e.action === "PAUSED").map((e) => e.data.paused)).toEqual([true, false]);
    const user = ev.filter((e) => e.agentId === "user");
    expect(user).toHaveLength(1);
    expect(String(user[0].data.message)).toContain("Focus on latency");
    expect(
      llm.calls.filter(isAgentCall).some((c) => textOf(c.messages.at(-1)!.content).includes("Focus on latency")),
    ).toBe(true);
    expect((await control(questId, { action: "pause" })).status).toBe(409);
  });

  it("complexity 5 waits for /approve, then completes", async () => {
    setup({ complexity: 5 });
    const { questId, plan } = await startQuest("A very hard question");
    expect(plan.requiresApproval).toBe(true);
    await waitFor(() => bus.replay(questId).length > 0, "approval request");
    expect(bus.replay(questId)[0]).toMatchObject({ action: "PAUSED", data: { awaitingApproval: true } });
    expect(llm.calls.filter(isAgentCall)).toHaveLength(0);

    expect((await approve(questId, true)).status).toBe(200);
    await finished(questId);
    const ev = bus.replay(questId);
    expect(ev.at(-1)!.action).toBe("DONE");
    expect(new Set(ev.filter((e) => e.action === "SPEAKING").map((e) => e.round))).toEqual(new Set([1, 2, 3]));
  });

  it("token budget cap ends with an ERROR event", async () => {
    setup({ complexity: 3, reply: () => ({ text: "expensive", usage: { promptTokens: 20_000, completionTokens: 5_000 } }) });
    const { questId } = await startQuest("Spend a lot");
    await finished(questId);
    const last = bus.replay(questId).at(-1)!;
    expect(last.action).toBe("ERROR");
    expect(last.data.reason).toBe("budget_exceeded");
    expect(bus.replay(questId).some((e) => e.action === "DONE")).toBe(false);
  });

  it("USD cost cap ends with an ERROR event", async () => {
    process.env.MAX_COST_USD_PER_QUEST = "0.01";
    setup({
      complexity: 3,
      reply: () => ({
        text: "pricey",
        usage: { promptTokens: 10, completionTokens: 10, costUsd: 1, modelUsed: "mock" },
      }),
    });
    const { questId } = await startQuest("Cost capped");
    await finished(questId);
    const last = bus.replay(questId).at(-1)!;
    expect(last.action).toBe("ERROR");
    expect(String(last.data.reason)).toMatch(/budget|cost/);
  });

  it("server restart marks stranded quests interrupted and rejects further control", async () => {
    setup({ complexity: 5 });
    const { questId } = await startQuest("Will be stranded");
    await waitFor(() => bus.replay(questId).length > 0, "approval request");

    // Simulate a restart: in-memory control state is lost, a fresh bus opens the same DB file.
    dropControl(questId);
    const db = createDb(dbPath);
    bus = new EventBus(db);
    (globalThis as G).__councilDb = db;
    (globalThis as G).__councilBus = bus;
    expect(recoverStrandedQuests({ db, bus })).toBe(1);

    const events = await stream(questId);
    expect(events.at(-1)).toMatchObject({ action: "ERROR", data: { reason: "server_restarted" } });
    const r = await approve(questId, true);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ reason: "server_restarted" });
    expect((await control(questId, { action: "pause" })).status).toBe(409);
  });
});
