import { textOf } from "@/lib/council/llm";
import { beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "@/lib/council/bus";
import { setLLMClient } from "@/lib/council/quests";
import { MockLLMClient } from "@/lib/council/llm";
import { createDb } from "@/lib/db";
import type { CouncilEvent } from "@/lib/shared";

type G = { __councilDb?: unknown; __councilBus?: unknown };

async function readSse(res: Response): Promise<{ id: number; event: CouncilEvent }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.includes("data: "))
    .map((b) => {
      const id = Number(/^id: (\d+)$/m.exec(b)![1]);
      return { id, event: JSON.parse(/^data: (.*)$/m.exec(b)![1]) as CouncilEvent };
    });
}

describe("quests e2e", () => {
  beforeAll(() => {
    const db = createDb(":memory:");
    (globalThis as G).__councilDb = db;
    (globalThis as G).__councilBus = new EventBus(db);
    setLLMClient(
      new MockLLMClient((p) =>
        textOf(p.messages[0].content).includes("Lead Orchestrator")
          ? JSON.stringify({ domain: "coding", complexity: 3 })
          : "a council reply",
      ),
    );
  });

  it("POST -> stream -> DONE; reconnect with Last-Event-ID has no duplicates", async () => {
    const { POST } = await import("@/app/api/quests/route");
    const { GET } = await import("@/app/api/quests/[id]/stream/route");

    const post = await POST(
      new Request("http://x/api/quests", { method: "POST", body: JSON.stringify({ query: "hi" }) }),
    );
    expect(post.status).toBe(201);
    const { questId, plan } = await post.json();
    expect(plan.executionPlan.assignedAgents.length).toBeGreaterThanOrEqual(2);

    const params = { params: Promise.resolve({ id: questId }) };
    const first = await readSse(await GET(new Request("http://x/s"), params));
    const n = plan.executionPlan.assignedAgents.length;
    const factCheckEvents = plan.executionPlan.maxRounds >= 2 || plan.complexityScore >= 4 ? 2 : 0;
    expect(first).toHaveLength(n * plan.executionPlan.maxRounds * 2 + 3 + factCheckEvents);
    expect(first.map((e) => e.id)).toEqual(first.map((_, i) => i + 1));
    expect(first.at(-1)!.event.action).toBe("DONE");
    expect(first[0].event.action).toBe("THINKING");
    expect(first[1].event.action).toBe("SPEAKING");

    const cut = 3;
    const rest = await readSse(
      await GET(new Request("http://x/s", { headers: { "last-event-id": String(cut) } }), params),
    );
    expect(rest.map((e) => e.id)).toEqual(first.slice(cut).map((e) => e.id));

    const viaQuery = await readSse(await GET(new Request(`http://x/s?lastEventId=${cut}`), params));
    expect(viaQuery.map((e) => e.id)).toEqual(rest.map((e) => e.id));
  });

  it("rejects empty query", async () => {
    const { POST } = await import("@/app/api/quests/route");
    const r = await POST(new Request("http://x", { method: "POST", body: "{}" }));
    expect(r.status).toBe(400);
  });
});
