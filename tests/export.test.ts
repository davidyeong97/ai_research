import { textOf } from "@/lib/council/llm";
import { beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "@/lib/council/bus";
import { MockLLMClient } from "@/lib/council/llm";
import { createQuest, setLLMClient } from "@/lib/council/quests";
import { createDb } from "@/lib/db";

type G = { __councilDb?: unknown; __councilBus?: unknown };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  await import("@/app/api/quests/[id]/export/route");
});

async function get(id: string, format?: string) {
  const { GET } = await import("@/app/api/quests/[id]/export/route");
  return GET(
    new Request(`http://x/api/quests/${id}/export${format ? `?format=${format}` : ""}`),
    params(id),
  );
}

describe("GET /api/quests/[id]/export", () => {
  it("exports md and json, 404 for unknown", async () => {
    const db = createDb(":memory:");
    (globalThis as G).__councilDb = db;
    (globalThis as G).__councilBus = new EventBus(db);
    setLLMClient(
      new MockLLMClient((p) =>
        textOf(p.messages[0].content).includes("Lead Orchestrator")
          ? JSON.stringify({ domain: "coding", complexity: 3 })
          : "reply text",
      ),
    );
    const { questId, done } = await createQuest("What is up?", {});
    await done;

    const md = await get(questId);
    expect(md.status).toBe(200);
    expect(md.headers.get("content-disposition")).toBe(
      `attachment; filename="council-${questId}.md"`,
    );
    const text = await md.text();
    expect(text).toContain("# What is up?");
    expect(text).toContain("## Plan");
    expect(text).toContain("Complexity: 3");
    expect(text).toContain("### Round 1");
    expect(text).toContain("reply text");
    expect(text).toContain("## Final answer");
    expect(text).toContain("## Totals");

    const js = await get(questId, "json");
    expect(js.headers.get("content-disposition")).toContain(`council-${questId}.json`);
    const body = await js.json();
    expect(Object.keys(body).sort()).toEqual([
      "agentMessages",
      "attachments",
      "events",
      "plan",
      "session",
    ]);
    expect(body.session.id).toBe(questId);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.agentMessages.length).toBeGreaterThan(0);

    expect((await get("nope")).status).toBe(404);
    expect((await get(questId, "xml")).status).toBe(400);
  });
});
