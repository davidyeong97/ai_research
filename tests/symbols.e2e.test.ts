import { beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "@/lib/council/bus";
import { MockLLMClient, textOf } from "@/lib/council/llm";
import { setLLMClient } from "@/lib/council/quests";
import { createDb } from "@/lib/db";

type G = { __councilDb?: unknown; __councilBus?: unknown };

const QUERIES = [
  '{"a":1}',
  `a\\b "c" 'd' <e>&f`,
  "```js\nconst x = {a:[1,2]};\n``` $% # @ |",
  "emoji 🚀🔥 a{b}c",
  '{"k":"v\\"} [x] \'y\' `z` <t>&$%#@| 🚀 '.repeat(120).slice(0, 4000),
];

describe("symbols in queries", () => {
  beforeAll(() => {
    const db = createDb(":memory:");
    (globalThis as G).__councilDb = db;
    (globalThis as G).__councilBus = new EventBus(db);
    setLLMClient(
      new MockLLMClient((p) => {
        const sys = textOf(p.messages[0].content);
        if (sys.includes("Lead Orchestrator")) {
          // Echo the user's symbols before an unfenced, fenced JSON answer.
          const user = textOf(p.messages[1].content);
          return `You said ${user.slice(0, 200)}\n\`\`\`json\n{"domain":"coding","complexity":3,"reasoning":"has "quotes" {x}"}\n\`\`\``;
        }
        return "reply with {braces} and <tags> & 🚀";
      }),
    );
  });

  it.each(QUERIES.map((q, i) => [i, q]))("query %i starts and renders", async (_i, query) => {
    const { POST } = await import("@/app/api/quests/route");
    const post = await POST(
      new Request("http://x/api/quests", { method: "POST", body: JSON.stringify({ query }) }),
    );
    expect(post.status).toBe(201);
    const { questId, plan } = await post.json();
    expect(plan.executionPlan.assignedAgents.length).toBeGreaterThanOrEqual(2);

    const { GET: stream } = await import("@/app/api/quests/[id]/stream/route");
    const params = { params: Promise.resolve({ id: questId }) };
    const text = await (await stream(new Request("http://x/s"), params)).text();
    expect(text).toContain("DONE");
    expect(text).toContain("{braces}");

    const { GET: exp } = await import("@/app/api/quests/[id]/export/route");
    const md = await (await exp(new Request(`http://x/e?format=md`), params)).text();
    expect(md).toContain(query.trim());
  });
});
