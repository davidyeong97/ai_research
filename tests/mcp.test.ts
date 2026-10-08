import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EventBus } from "@/lib/council/bus";
import { setLLMClient } from "@/lib/council/quests";
import { MockLLMClient, textOf } from "@/lib/council/llm";
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

  describe("attachments", () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const png = { filename: "chart.png", mimeType: "image/png", dataBase64: PNG.toString("base64") };
    const md = { filename: "notes.md", mimeType: "text/markdown", dataBase64: Buffer.from("# Notes\nhello").toString("base64") };
    let dir: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-att-"));
      process.env.UPLOADS_DIR = dir;
    });
    afterAll(() => {
      delete process.env.UPLOADS_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("council_ask accepts png + md and reports them in status and export", async () => {
      const r = await call(client, "council_ask", { question: "Review these", attachments: [png, md], waitSeconds: 10 });
      expect(r.isError).toBeFalsy();
      const names = (r.structuredContent!.attachments as { filename: string }[]).map((a) => a.filename).sort();
      expect(names).toEqual(["chart.png", "notes.md"]);
      expect(r.content[0].text).toContain("Attachments: ");
      const id = r.structuredContent!.questId as string;
      const st = await call(client, "council_status", { questId: id });
      expect(st.structuredContent!.attachments).toHaveLength(2);
      const ex = await call(client, "council_export", { questId: id });
      expect(ex.content[0].text).toContain("chart.png");
    });

    it("council_start lists attachment names", async () => {
      const r = await call(client, "council_start", { question: "Look", attachments: [md] });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain("notes.md");
      expect((r.structuredContent!.attachments as unknown[]).length).toBe(1);
    });

    it("rejects unsupported types, bad base64, too many and oversize as tool errors", async () => {
      const exe = { filename: "a.exe", mimeType: "application/octet-stream", dataBase64: Buffer.from([1, 2, 3, 0]).toString("base64") };
      const bad = await call(client, "council_ask", { question: "x", attachments: [exe] });
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toMatch(/Unsupported file type/);

      const b64 = await call(client, "council_ask", { question: "x", attachments: [{ filename: "a.md", dataBase64: "!!!notbase64" }] });
      expect(b64.isError).toBe(true);
      expect(b64.content[0].text).toMatch(/base64/);

      const many = await call(client, "council_ask", { question: "x", attachments: Array(6).fill(md) });
      expect(many.isError).toBe(true);

      vi.stubEnv("MAX_UPLOAD_MB", "0.0001"); // ~104 bytes
      const big = await call(client, "council_ask", {
        question: "x",
        attachments: [{ filename: "big.md", dataBase64: Buffer.from("a".repeat(500)).toString("base64") }],
      });
      expect(big.isError).toBe(true);
      expect(big.content[0].text).toMatch(/too large|Too small|invalid/i);
    });

    it("saves nothing when one attachment in a batch is invalid", async () => {
      const before = fs.readdirSync(dir).length;
      const exe = { filename: "a.exe", dataBase64: Buffer.from([1, 2, 3, 0]).toString("base64") };
      const r = await call(client, "council_start", { question: "x", attachments: [md, exe] });
      expect(r.isError).toBe(true);
      expect(fs.readdirSync(dir).length).toBe(before);
    });
  });
});
