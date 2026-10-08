import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EventBus } from "@/lib/council/bus";
import { setLLMClient } from "@/lib/council/quests";
import { MockLLMClient } from "@/lib/council/llm";
import { createDb } from "@/lib/db";

type G = { __councilDb?: unknown; __councilBus?: unknown };

let delayMs = 0;
let complexity = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(): Promise<Client> {
  const { POST, GET } = await import("@/app/api/mcp/route");
  const routeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return req.method === "POST" ? POST(req) : GET();
  }) as typeof fetch;
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), { fetch: routeFetch });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  return client;
}

const call = async (c: Client, name: string, args: Record<string, unknown>) =>
  (await c.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
    structuredContent?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

let client: Client;

beforeAll(async () => {
  const db = createDb(":memory:");
  (globalThis as G).__councilDb = db;
  (globalThis as G).__councilBus = new EventBus(db);
  const mock = new MockLLMClient((p) =>
    p.messages[0].content.includes("Lead Orchestrator")
      ? JSON.stringify({ domain: "coding", complexity })
      : "a council reply",
  );
  setLLMClient({
    async *streamChat(params) {
      if (delayMs && !params.messages[0].content.includes("Lead Orchestrator")) await sleep(delayMs);
      yield* mock.streamChat(params);
    },
  });
  client = await connect();
});
afterAll(async () => {
  await client.close();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  delayMs = 0;
  complexity = 3;
  vi.unstubAllEnvs();
});

describe("MCP server", () => {
  it("lists the 8 tools", async () => {
    const { tools } = await client.listTools();
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

  it("GET and DELETE return 405", async () => {
    const { GET, DELETE } = await import("@/app/api/mcp/route");
    expect((await GET()).status).toBe(405);
    expect((await DELETE()).status).toBe(405);
  });

  it("council_ask returns the final answer for a fast quest", async () => {
    const r = await call(client, "council_ask", { question: "fast?", waitSeconds: 10 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ status: "done", source: "mcp" });
    expect(r.structuredContent?.finalAnswer).toBeTruthy();
    expect(r.content[0].text).toContain("Final answer");
  });

  it("council_ask returns a questId when slow; council_status long-polls to completion", async () => {
    delayMs = 300;
    const r = await call(client, "council_ask", { question: "slow?", waitSeconds: 0 });
    expect(r.structuredContent?.status).toBe("running");
    const id = r.structuredContent!.questId as string;
    expect(r.content[0].text).toContain("council_status");
    const s = await call(client, "council_status", { questId: id, waitSeconds: 20 });
    expect(s.structuredContent?.status).toBe("done");
    const res = await call(client, "council_result", { questId: id });
    expect(res.structuredContent?.finalAnswer).toBeTruthy();
  });

  it("approval flow", async () => {
    complexity = 5;
    const r = await call(client, "council_start", { question: "big?" });
    expect(r.structuredContent).toMatchObject({ status: "awaiting_approval", requiresApproval: true });
    const id = r.structuredContent!.questId as string;
    const st = await call(client, "council_status", { questId: id, waitSeconds: 5 });
    expect(st.structuredContent?.awaitingApproval).toBe(true);
    const ap = await call(client, "council_approve", { questId: id, approve: true });
    expect(ap.isError).toBeFalsy();
    const done = await call(client, "council_status", { questId: id, waitSeconds: 20 });
    expect(done.structuredContent?.status).toBe("done");
    const bad = await call(client, "council_approve", { questId: id, approve: true });
    expect(bad.isError).toBe(true);
  });

  it("cancel, export and list", async () => {
    delayMs = 500;
    const r = await call(client, "council_start", { question: "cancel me?" });
    const id = r.structuredContent!.questId as string;
    const c = await call(client, "council_control", { questId: id, action: "cancel" });
    expect(c.isError).toBeFalsy();
    const s = await call(client, "council_status", { questId: id, waitSeconds: 10 });
    expect(s.structuredContent?.status).toBe("cancelled");
    const e = await call(client, "council_export", { questId: id, format: "md" });
    expect(e.content[0].text).toContain("cancel me?");
    const l = await call(client, "council_list", { status: "cancelled" });
    expect(l.structuredContent?.quests.some((q: { questId: string }) => q.questId === id)).toBe(true);
  });

  it("returns tool errors for unknown quests and guardrails", async () => {
    const nf = await call(client, "council_status", { questId: "nope" });
    expect(nf.isError).toBe(true);
    expect(nf.content[0].text).toContain("council_list");

    delayMs = 500;
    vi.stubEnv("MCP_MAX_CONCURRENT", "1");
    const first = await call(client, "council_start", { question: "one" });
    const second = await call(client, "council_ask", { question: "two", waitSeconds: 0 });
    expect(second.isError).toBe(true);
    expect(second.structuredContent?.reason).toBe("mcp_max_concurrent");
    await call(client, "council_control", { questId: first.structuredContent!.questId, action: "cancel" });
  });

  it("exposes the transcript resource", async () => {
    const { quests } = (await call(client, "council_list", {})).structuredContent as { quests: { questId: string }[] };
    const res = await client.readResource({ uri: `council://quests/${quests[0].questId}/transcript` });
    expect((res.contents[0] as { text: string }).text).toContain("## Transcript");
  });
});
