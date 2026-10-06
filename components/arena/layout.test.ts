import { describe, expect, it } from "vitest";
import { orderAgents, seatPositions, spriteScale } from "./layout";

describe("layout", () => {
  it("returns no seats for 0 agents", () => {
    expect(seatPositions(0, 400, 400)).toEqual([]);
  });
  it("seats the first agent at the head (top centre)", () => {
    const [head, ...rest] = seatPositions(5, 400, 300);
    expect(head.x).toBeCloseTo(200);
    for (const p of rest) expect(p.y).toBeGreaterThan(head.y - 1e-6);
    expect(head.y).toBeLessThan(150);
  });
  it("places distinct seats inside the stage", () => {
    for (const n of [1, 2, 3, 6, 8]) {
      const seats = seatPositions(n, 500, 400);
      expect(seats).toHaveLength(n);
      expect(new Set(seats.map((s) => `${s.x.toFixed(2)},${s.y.toFixed(2)}`)).size).toBe(n);
      for (const s of seats) {
        expect(s.x).toBeGreaterThan(0);
        expect(s.x).toBeLessThan(500);
        expect(s.y).toBeGreaterThan(0);
        expect(s.y).toBeLessThan(400);
      }
    }
  });
  it("scales with stage size", () => {
    const a = seatPositions(4, 200, 200);
    const b = seatPositions(4, 400, 400);
    expect(b[1].x - 200).toBeCloseTo((a[1].x - 100) * 2);
  });
  it("puts the lead first", () => {
    expect(orderAgents([{ id: "a" }, { id: "lead" }, { id: "b" }]).map((x) => x.id)).toEqual([
      "lead",
      "a",
      "b",
    ]);
  });
  it("uses an integer scale", () => {
    const s = spriteScale(600, 500, 6);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(2);
  });
});
