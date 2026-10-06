import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db";
import { EventBus, getBus, type NewCouncilEvent } from "./bus";
import type { CouncilEvent } from "../shared";

const ev = (questId: string, agentId = "a"): NewCouncilEvent => ({
  questId,
  round: 1,
  agentId,
  action: "THINKING",
  tokensUsed: 0,
  data: {},
});

describe("EventBus", () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus(createDb(":memory:"));
  });

  it("assigns per-quest increasing seq and persists", () => {
    expect(bus.publish(ev("q1")).id).toBe(1);
    expect(bus.publish(ev("q1")).id).toBe(2);
    expect(bus.publish(ev("q2")).id).toBe(1);
    expect(bus.replay("q1").map((e) => e.id)).toEqual([1, 2]);
  });

  it("replays missed events then streams live without duplicates", () => {
    bus.publish(ev("q"));
    bus.publish(ev("q"));
    const got: number[] = [];
    const unsub = bus.subscribe("q", 1, (e: CouncilEvent) => got.push(e.id));
    bus.publish(ev("q"));
    expect(got).toEqual([2, 3]);
    unsub();
    bus.publish(ev("q"));
    expect(got).toEqual([2, 3]);
  });

  it("continues seq after restart from persisted events", () => {
    const db = createDb(":memory:");
    new EventBus(db).publish(ev("q"));
    expect(new EventBus(db).publish(ev("q")).id).toBe(2);
  });

  it("getBus is a globalThis singleton", () => {
    process.env.DATABASE_PATH = ":memory:";
    expect(getBus()).toBe(getBus());
  });
});
