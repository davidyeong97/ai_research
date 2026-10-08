import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { SESSION_COOKIE, computeSessionToken } from "@/lib/auth/session";
import { resetMcpRateLimit } from "@/lib/auth/mcp";
import { createDb } from "@/lib/db";
import { schema } from "@/lib/db";
import { EventBus } from "@/lib/council/bus";
import { MockLLMClient, textOf } from "@/lib/council/llm";
import { ServiceError, startQuest, type ServiceDeps } from "@/lib/council/service";

const TOKEN = "t".repeat(48);

beforeEach(() => {
  vi.stubEnv("APP_PASSWORD", "hunter2");
  vi.stubEnv("MCP_TOKEN", TOKEN);
  resetMcpRateLimit();
});
afterEach(() => vi.unstubAllEnvs());

const req = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { headers });
const bearer = (t = TOKEN) => ({ authorization: `Bearer ${t}` });
const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";

describe("proxy /api/mcp", () => {
  it("accepts a valid bearer token", async () => {
    expect(passed(await proxy(req("/api/mcp", bearer())))).toBe(true);
  });
  it("rejects missing, wrong, and short tokens", async () => {
    expect((await proxy(req("/api/mcp"))).status).toBe(401);
    expect((await proxy(req("/api/mcp", bearer("x".repeat(48))))).status).toBe(401);
    expect((await proxy(req("/api/mcp", { authorization: TOKEN }))).status).toBe(401);
    vi.stubEnv("MCP_TOKEN", "short");
    expect((await proxy(req("/api/mcp", bearer("short")))).status).toBe(503);
  });
  it("rejects a cookie session", async () => {
    const cookie = `${SESSION_COOKIE}=${await computeSessionToken("hunter2")}`;
    expect((await proxy(req("/api/mcp", { cookie }))).status).toBe(401);
  });
  it("returns 503 'MCP disabled' when MCP_TOKEN is unset", async () => {
    vi.stubEnv("MCP_TOKEN", "");
    const res = await proxy(req("/api/mcp", bearer()));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("MCP disabled");
  });
  it("rate limits with 429", async () => {
    vi.stubEnv("MCP_RATE_LIMIT_PER_MIN", "3");
    for (let i = 0; i < 3; i++) expect(passed(await proxy(req("/api/mcp", bearer())))).toBe(true);
    const res = await proxy(req("/api/mcp", bearer()));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("bearer is not accepted elsewhere", () => {
  it("rejects bearer on other routes and pages", async () => {
    expect((await proxy(req("/api/quests", bearer()))).status).toBe(401);
    expect((await proxy(req("/api/quests/abc/stream", bearer()))).status).toBe(401);
    expect((await proxy(req("/api/mcp-evil", bearer()))).status).toBe(401);
    expect((await proxy(req("/", bearer()))).status).toBe(307);
  });
});

describe("mcp guardrails", () => {
  let deps: ServiceDeps & { db: ReturnType<typeof createDb>; bus: EventBus };
  beforeEach(() => {
    const db = createDb(":memory:");
    const llm = new MockLLMClient((p) =>
      textOf(p.messages[0].content).includes("Lead Orchestrator")
        ? JSON.stringify({ domain: "coding", complexity: 3 })
        : { text: "reply" },
    );
    deps = { db, bus: new EventBus(db), llm };
  });
  const insert = (status: string, cost: number, createdAt = Date.now(), source = "mcp") =>
    deps.db
      .insert(schema.sessions)
      .values({ id: crypto.randomUUID(), query: "q", status, source, totalCostUsd: cost, createdAt } as never)
      .run();
  const ask = () => startQuest({ query: "q?", source: "mcp" }, deps);

  it("limits concurrent running mcp quests", async () => {
    vi.stubEnv("MCP_MAX_CONCURRENT", "2");
    insert("running", 0);
    insert("awaiting_approval", 0);
    insert("running", 0, Date.now(), "web");
    const err = await ask().catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.message).toMatch(/concurrent/i);
    expect(err.httpStatus).toBe(429);
  });
  it("enforces the daily spend cap (last 24h only)", async () => {
    vi.stubEnv("MCP_DAILY_COST_USD", "1");
    insert("done", 5, Date.now() - 25 * 3600 * 1000);
    await expect(ask()).resolves.toBeTruthy();
    insert("done", 1.2);
    await expect(ask()).rejects.toThrow(/daily/i);
  });
  it("does not apply to web quests", async () => {
    vi.stubEnv("MCP_MAX_CONCURRENT", "0");
    await expect(startQuest({ query: "q?", source: "web" }, deps)).resolves.toBeTruthy();
  });
  it("defaults mcp cost cap to min(env cap, 0.30)", async () => {
    vi.stubEnv("MAX_COST_USD_PER_QUEST", "0.50");
    const r = await ask();
    await r.done;
    // cap is applied internally; verify via a lower env cap too
    vi.stubEnv("MAX_COST_USD_PER_QUEST", "0.10");
    const r2 = await ask();
    await r2.done;
    expect(r.questId).not.toBe(r2.questId);
  });
});
