import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { proxy } from "@/proxy";
import { resetMcpRateLimit } from "@/lib/auth/mcp";
import { EventBus } from "@/lib/council/bus";
import { setLLMClient } from "@/lib/council/quests";
import { MockLLMClient, textOf } from "@/lib/council/llm";
import { createDb } from "@/lib/db";

/**
 * End-to-end: MCP SDK client -> proxy (auth/rate limit) -> /api/mcp route handler,
 * then the web API surfaces (/api/quests, stream, export) for the same quest.
 */
type G = { __councilDb?: unknown; __councilBus?: unknown };
const TOKEN = "e".repeat(48);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let delayMs = 0;
let complexity = 3;

/** Routes a fetch through proxy() first, exactly like Next would, then to the handler. */
const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = new Request(input, init);
  const nreq = new NextRequest(raw.url, { method: raw.method, headers: raw.headers, body: raw.body, duplex: "half" } as never);
  const gate = await proxy(nreq);
  if (gate.headers.get("x-middleware-next") !== "1") return gate;
  const url = new URL(raw.url);
  const req = new Request(raw.url, { method: raw.method, headers: raw.headers, body: raw.method === "POST" ? await raw.clone().text() : undefined });
  if (url.pathname === "/api/mcp") {
    const m = await import("@/app/api/mcp/route");
    return raw.method === "POST" ? m.POST(req) : raw.method === "DELETE" ? m.DELETE() : m.GET();
  }
  if (url.pathname === "/api/quests") {
    const m = await import("@/app/api/quests/route");
    return raw.method === "POST" ? m.POST(req) : m.GET(req);
  }
  const stream = url.pathname.match(/^\/api\/quests\/([^/]+)\/stream$/);
  if (stream) {
    const m = await import("@/app/api/quests/[id]/stream/route");
    return m.GET(req, { params: Promise.resolve({ id: stream[1] }) });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

async function connect(token: string | null = TOKEN): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
    fetch: appFetch,
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(transport);
  return client;
}

type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (c: Client, name: string, args: Record<string, unknown>) =>
  (await c.callTool({ name, arguments: args })) as Result;

let client: Client;

beforeAll(async () => {
  const db = createDb(":memory:");
  (globalThis as G).__councilDb = db;
  (globalThis as G).__councilBus = new EventBus(db);
  const mock = new MockLLMClient((p) =>
    textOf(p.messages[0].content).includes("Lead Orchestrator")
      ? JSON.stringify({ domain: "coding", complexity })
      : "a council reply",
  );
  setLLMClient({
    async *streamChat(params) {
      if (delayMs && !textOf(params.messages[0].content).includes("Lead Orchestrator")) await sleep(delayMs);
      yield* mock.streamChat(params);
    },
    embed: (params) => mock.embed(params),
  });
  vi.stubEnv("APP_PASSWORD", "hunter2");
  vi.stubEnv("MCP_TOKEN", TOKEN);
  vi.stubEnv("MCP_RATE_LIMIT_PER_MIN", "10000");
  client = await connect();
});
afterAll(async () => {
  await client.close();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  delayMs = 0;
  complexity = 3;
  vi.stubEnv("MCP_MAX_CONCURRENT", "50");
  vi.stubEnv("MCP_DAILY_COST_USD", "100");
  resetMcpRateLimit();
});

const rpc = (headers: Record<string, string>) =>
  appFetch("http://localhost/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("auth over the wire", () => {
  it("rejects missing, invalid bearer and cookie-only; accepts valid", async () => {
    expect((await rpc({})).status).toBe(401);
    expect((await rpc({ authorization: `Bearer ${"x".repeat(48)}` })).status).toBe(401);
    expect((await rpc({ cookie: "council_session=whatever" })).status).toBe(401);
    expect((await rpc({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it("SDK client without a token fails to connect", async () => {
    await expect(connect(null)).rejects.toThrow();
  });

  it("returns 429 once the rate limit is exceeded", async () => {
    vi.stubEnv("MCP_RATE_LIMIT_PER_MIN", "2");
    const h = { authorization: `Bearer ${TOKEN}` };
    expect((await rpc(h)).status).toBe(200);
    expect((await rpc(h)).status).toBe(200);
    const limited = await rpc(h);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    vi.stubEnv("MCP_RATE_LIMIT_PER_MIN", "10000");
  });
});

describe("tools", () => {
  it("lists the 8 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(8);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "council_approve",
      "council_ask",
      "council_control",
      "council_export",
      "council_list",
      "council_result",
      "council_start",
      "council_status",
    ]);
  });

  it("ask -> status -> result loop, then web API shows source mcp and the deep link replays events", async () => {
    delayMs = 200;
    const t0 = Date.now();
    const r = await call(client, "council_ask", { question: "loop?", waitSeconds: 0 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.structuredContent?.status).toBe("running");
    const id = r.structuredContent!.questId as string;
    const s = await call(client, "council_status", { questId: id, waitSeconds: 20 });
    expect(s.structuredContent?.status).toBe("done");
    const res = await call(client, "council_result", { questId: id });
    expect(res.structuredContent?.finalAnswer).toBeTruthy();

    const list = await appFetch("http://localhost/api/quests?limit=50", { headers: {} });
    // web routes are protected by the cookie session, not the bearer
    expect(list.status).toBe(401);
    const { computeSessionToken, SESSION_COOKIE } = await import("@/lib/auth/session");
    const cookie = `${SESSION_COOKIE}=${await computeSessionToken("hunter2")}`;
    const ok = await appFetch("http://localhost/api/quests?limit=50", { headers: { cookie } });
    const { quests } = (await ok.json()) as { quests: { questId?: string; id?: string; source?: string }[] };
    const mine = quests.find((q) => (q.questId ?? q.id) === id);
    expect(mine?.source).toBe("mcp");

    // Deep link target (/?quest=<id>) loads via the SSE stream replay.
    const sse = await appFetch(`http://localhost/api/quests/${id}/stream`, { headers: { cookie } });
    const body = await sse.text();
    expect(body).toContain('"action":"DONE"');
    expect(body).toContain('"action":"SPEAKING"');
  });

  it("approval gate, inject and cancel", async () => {
    complexity = 5;
    const r = await call(client, "council_start", { question: "big?" });
    expect(r.structuredContent).toMatchObject({ status: "awaiting_approval", requiresApproval: true });
    const id = r.structuredContent!.questId as string;
    const ap = await call(client, "council_approve", { questId: id, approve: true });
    expect(ap.isError).toBeFalsy();
    expect((await call(client, "council_status", { questId: id, waitSeconds: 20 })).structuredContent?.status).toBe("done");

    complexity = 3;
    delayMs = 500;
    const q = await call(client, "council_start", { question: "steer me" });
    const qid = q.structuredContent!.questId as string;
    const noGuide = await call(client, "council_control", { questId: qid, action: "inject" });
    expect(noGuide.isError).toBe(true);
    const inj = await call(client, "council_control", { questId: qid, action: "inject", guidance: "focus on cost" });
    expect(inj.isError).toBeFalsy();
    const cancel = await call(client, "council_control", { questId: qid, action: "cancel" });
    expect(cancel.isError).toBeFalsy();
    expect((await call(client, "council_status", { questId: qid, waitSeconds: 10 })).structuredContent?.status).toBe("cancelled");
  });

  it("accepts attachments and exports them", async () => {
    const md = { filename: "n.md", mimeType: "text/markdown", dataBase64: Buffer.from("# hi").toString("base64") };
    const r = await call(client, "council_ask", { question: "with file", attachments: [md], waitSeconds: 10 });
    expect(r.isError).toBeFalsy();
    const id = r.structuredContent!.questId as string;
    const ex = await call(client, "council_export", { questId: id, format: "md" });
    expect(ex.content[0].text).toContain("n.md");
    const json = await call(client, "council_export", { questId: id, format: "json" });
    expect(() => JSON.parse(json.content[0].text)).not.toThrow();
  });

  it("guardrails: concurrency cap and daily cost cap return tool errors", async () => {
    delayMs = 500;
    vi.stubEnv("MCP_MAX_CONCURRENT", "1");
    // Drain anything still running from earlier tests.
    await sleep(1500);
    const first = await call(client, "council_start", { question: "one" });
    const second = await call(client, "council_ask", { question: "two", waitSeconds: 0 });
    expect(second.isError).toBe(true);
    expect(second.structuredContent?.reason).toBe("mcp_max_concurrent");
    await call(client, "council_control", { questId: first.structuredContent!.questId, action: "cancel" });

    vi.stubEnv("MCP_MAX_CONCURRENT", "50");
    vi.stubEnv("MCP_DAILY_COST_USD", "0");
    const capped = await call(client, "council_ask", { question: "three", waitSeconds: 0 });
    expect(capped.isError).toBe(true);
    expect(capped.structuredContent?.reason).toBe("mcp_daily_cost");
  });
});
