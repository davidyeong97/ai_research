import { describe, expect, it, vi } from "vitest";

vi.mock("pixi.js", () => ({ Texture: { from: vi.fn() } }));

import { AVATARS, PALETTES, SPRITE_GRIDS, SPRITE_SIZE, resolveAvatar } from "./sprites";

describe("sprites", () => {
  it("defines a grid and palette for every avatar", () => {
    for (const a of ["wizard", "scout", "rogue", "knight", "cleric", "bard"]) {
      expect(AVATARS).toContain(a);
      expect(SPRITE_GRIDS[a as keyof typeof SPRITE_GRIDS]).toBeDefined();
      expect(PALETTES[a as keyof typeof PALETTES]).toBeDefined();
    }
  });
  it("has consistent 16x16 grids using only known palette keys", () => {
    for (const a of AVATARS) {
      const grid = SPRITE_GRIDS[a];
      expect(grid).toHaveLength(SPRITE_SIZE);
      for (const row of grid) {
        expect(row).toHaveLength(SPRITE_SIZE);
        for (const ch of row) expect(ch === "." || ch in PALETTES[a]).toBe(true);
      }
    }
  });
  it("gives each class a distinct palette and silhouette", () => {
    expect(new Set(AVATARS.map((a) => PALETTES[a].b)).size).toBe(AVATARS.length);
    expect(new Set(AVATARS.map((a) => SPRITE_GRIDS[a].join())).size).toBe(AVATARS.length);
  });
  it("falls back for unknown avatars", () => {
    expect(resolveAvatar("nope")).toBe("wizard");
  });
});
