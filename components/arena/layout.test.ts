import { describe, expect, it } from "vitest";
import { orderAgents, seatPositions, spriteScale, tableGeometry } from "./layout";

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
  it("shrinks the table and leaves headroom for the head seat", () => {
    const t = tableGeometry(500, 500);
    expect(t.rx).toBeLessThanOrEqual(500 * 0.2 * 0.8);
    expect(t.ry).toBeLessThanOrEqual(500 * 0.17 * 0.8);
    for (const [w, h] of [[360, 300], [500, 500], [900, 700]]) {
      const [head] = seatPositions(5, w, h);
      const px = 16 * spriteScale(w, h, 5);
      expect(head.y - px - 30).toBeGreaterThanOrEqual(8);
    }
  });
  it("keeps seats apart and off the table for 1-7 agents", () => {
    for (const [w, h] of [[360, 300], [500, 500], [900, 700]]) {
      const t = tableGeometry(w, h);
      for (let n = 1; n <= 7; n++) {
        const seats = seatPositions(n, w, h);
        const px = 16 * spriteScale(w, h, n);
        for (const s of seats) {
          const d = ((s.x - t.cx) / t.rx) ** 2 + ((s.y - t.cy) / t.ry) ** 2;
          expect(d).toBeGreaterThan(1);
          expect(s.x - px / 2).toBeGreaterThanOrEqual(0);
          expect(s.x + px / 2).toBeLessThanOrEqual(w);
          expect(s.y + 26).toBeLessThanOrEqual(h);
        }
        for (let i = 0; i < n; i++)
          for (let j = i + 1; j < n; j++) {
            const dx = Math.abs(seats[i].x - seats[j].x);
            const dy = Math.abs(seats[i].y - seats[j].y);
            expect(dx >= px * 0.9 || dy >= px * 0.9).toBe(true);
          }
      }
    }
  });
});
