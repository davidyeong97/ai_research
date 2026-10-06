import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { EventBus } from "@/lib/council/bus";
import { recoverStrandedQuests } from "@/lib/council/recovery";
import { createControl, dropControl } from "@/lib/council/control";
import { createDb, schema, type DB } from "@/lib/db";

let db: DB;
let bus: EventBus;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) });
const status = (id: string) => db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get()?.status;

function seed(id: string, st: string) {
  db.insert(schema.sessions).values({ id, query: "q", status: st, createdAt: Date.now() }).run();
}

beforeEach(() => {
  db = createDb(":memory:");
  bus = new EventBus(db);
  (globalThis as { __councilDb?: unknown }).__councilDb = db;
  (globalThis as { __councilBus?: unknown }).__councilBus = bus;
});

describe("recoverStrandedQuests", () => {
  it("interrupts stranded quests with one ERROR each, leaves others, is idempotent", async () => {
    seed("a", "running");
    seed("b", "awaiting_approval");
    seed("c", "done");
    seed("d", "cancelled");
    bus.publish({ questId: "a", round: 2, agentId: "x", action: "SPEAKING", tokensUsed: 0, data: {} });

    expect(recoverStrandedQuests({ db, bus })).toBe(2);
    expect(status("a")).toBe("interrupted");
    expect(status("b")).toBe("interrupted");
    expect(status("c")).toBe("done");
    expect(status("d")).toBe("cancelled");

    const ea = bus.replay("a");
    expect(ea.map((e) => e.action)).toEqual(["SPEAKING", "ERROR"]);
    expect(ea[1]).toMatchObject({ id: 2, round: 2, agentId: "lead", data: { reason: "server_restarted" } });
    expect(bus.replay("b")).toHaveLength(1);
    expect(bus.replay("b")[0]).toMatchObject({ round: 0, action: "ERROR" });
    expect(bus.replay("c")).toHaveLength(0);

    expect(recoverStrandedQuests({ db, bus })).toBe(0);
    expect(bus.replay("a")).toHaveLength(2);

    // fresh bus (restart) replays the terminal event to new subscribers
    const got: string[] = [];
    new EventBus(db).subscribe("a", 0, (e) => got.push(e.action));
    expect(got.at(-1)).toBe("ERROR");

    const { POST: control } = await import("@/app/api/quests/[id]/control/route");
    const { POST: approve } = await import("@/app/api/quests/[id]/approve/route");
    for (const r of [await control(post({ action: "pause" }), params("a")), await approve(post({ approved: true }), params("b"))]) {
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ reason: "server_restarted" });
    }
  });

  it("skips quests with an in-memory control", () => {
    seed("live", "running");
    createControl("live");
    expect(recoverStrandedQuests({ db, bus })).toBe(0);
    expect(status("live")).toBe("running");
    dropControl("live");
  });
});
