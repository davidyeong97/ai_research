import { describe, expect, it } from "vitest";
import { placeBubble, rectsOverlap, truncateLine } from "./bubbles";

describe("truncateLine", () => {
  it("keeps short text and collapses whitespace", () => {
    expect(truncateLine("hi\n  there")).toBe("hi there");
  });
  it("truncates to max with ellipsis", () => {
    const out = truncateLine("a".repeat(300));
    expect(out.length).toBe(140);
    expect(out.endsWith("…")).toBe(true);
  });
  it("handles empty", () => {
    expect(truncateLine("   ")).toBe("");
  });
});

describe("placeBubble", () => {
  const base = { bw: 100, bh: 40, stageW: 400, stageH: 400 };
  it("places above the anchor by default", () => {
    const p = placeBubble({ ...base, anchorX: 200, anchorTop: 200, anchorBottom: 260 });
    expect(p.below).toBe(false);
    expect(p.y + p.h).toBeLessThanOrEqual(200);
    expect(p.x).toBe(150);
  });
  it("flips below when there is no room above", () => {
    const p = placeBubble({ ...base, anchorX: 200, anchorTop: 20, anchorBottom: 80 });
    expect(p.below).toBe(true);
    expect(p.y).toBeGreaterThanOrEqual(80);
  });
  it("clamps inside stage bounds horizontally", () => {
    const l = placeBubble({ ...base, anchorX: 0, anchorTop: 200, anchorBottom: 260 });
    expect(l.x).toBeGreaterThanOrEqual(0);
    const r = placeBubble({ ...base, anchorX: 400, anchorTop: 200, anchorBottom: 260 });
    expect(r.x + r.w).toBeLessThanOrEqual(400);
    expect(r.tailX).toBeLessThanOrEqual(r.x + r.w);
  });
  it("avoids neighbours when an alternative exists", () => {
    const p = placeBubble({
      ...base,
      anchorX: 200,
      anchorTop: 200,
      anchorBottom: 260,
      avoid: [{ x: 100, y: 100, w: 200, h: 90 }],
    });
    expect(p.below).toBe(true);
    expect(rectsOverlap(p, { x: 100, y: 100, w: 200, h: 90 })).toBe(false);
  });
  it("shrinks oversized bubbles to the stage", () => {
    const p = placeBubble({ ...base, bw: 900, anchorX: 200, anchorTop: 200, anchorBottom: 260 });
    expect(p.w).toBeLessThanOrEqual(400);
  });
  it("places the top anchor's bubble to the right, tail pointing sideways", () => {
    const sprite = { x: 168, y: 30, w: 64, h: 64 };
    const p = placeBubble({
      ...base,
      bh: 80,
      anchorX: 200,
      anchorTop: 30,
      anchorBottom: 120,
      sprite,
      preferSide: true,
    });
    expect(p.side).toBe("right");
    expect(p.x).toBeGreaterThanOrEqual(sprite.x + sprite.w);
    expect(p.tailX).toBe(p.x);
  });
  it("falls to the left when the right is blocked or off-stage", () => {
    const sprite = { x: 330, y: 30, w: 64, h: 64 };
    const p = placeBubble({
      ...base,
      anchorX: 362,
      anchorTop: 30,
      anchorBottom: 120,
      sprite,
      preferSide: true,
    });
    expect(p.side).toBe("left");
    expect(p.x + p.w).toBeLessThanOrEqual(sprite.x);
  });
  it("uses a side placement when above would be clipped, and never leaves the stage", () => {
    for (const ax of [0, 50, 200, 350, 400]) {
      for (const at of [0, 10, 60, 200, 390]) {
        const sprite = { x: ax - 32, y: at, w: 64, h: 64 };
        const p = placeBubble({
          ...base,
          bh: 120,
          anchorX: ax,
          anchorTop: at,
          anchorBottom: at + 90,
          sprite,
        });
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x + p.w).toBeLessThanOrEqual(400);
        expect(p.y + p.h).toBeLessThanOrEqual(400);
      }
    }
    const p = placeBubble({
      ...base,
      bh: 120,
      anchorX: 200,
      anchorTop: 10,
      anchorBottom: 100,
      sprite: { x: 168, y: 10, w: 64, h: 64 },
    });
    expect(p.side).toBe("right");
  });
});
