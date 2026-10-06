import { Texture } from "pixi.js";

export const SPRITE_SIZE = 16;
export const AVATARS = ["wizard", "scout", "rogue", "knight", "cleric", "bard"] as const;
export type Avatar = (typeof AVATARS)[number];

/**
 * Colour-index grids, 16x16. Characters index into the palette:
 * . transparent, h hat/hair, s skin, b body, t trim, e eyes, d dark (boots/outline), w weapon/prop.
 */
const BODY = [
  "....dssssssd....",
  "...dsessssesd....",
  "....dssssssd....",
  ".....dssssd.....",
  "....dbbttbbd....",
  "...dbbbttbbbd...",
  "..sdbbbttbbbds..",
  "..sdbbbbbbbbds..",
  "..wdbbbbbbbbd...",
  "...dbbbbbbbbd...",
  "....bbbddbbb....",
  "....dddddddd....",
];

/** Top 4 rows (head gear) per class. */
const HEAD: Record<Avatar, string[]> = {
  wizard: ["......hh........", ".....hhhh.......", "...hhhhhhhhh....", "....hhhhhhhh...."],
  scout: ["................", "....hhhhhhhh....", "...hhhhhhhhhh...", "...hh......hh..."],
  rogue: ["................", "....dddddddd....", "...dhhhhhhhhd...", "...hh......hh..."],
  knight: ["......tt........", "....hhhhhhhh....", "...hhhhhhhhhh...", "...hhh....hhh..."],
  cleric: ["................", ".....tttttt.....", "....hhhhhhhh....", "...hh......hh..."],
  bard: ["........tt......", "....hhhhhhhh....", "...hhhhhhhhhhw..", "...hh......hh..."],
};

function pad(row: string): string {
  return row.padEnd(SPRITE_SIZE, ".").slice(0, SPRITE_SIZE);
}

export const SPRITE_GRIDS: Record<Avatar, string[]> = Object.fromEntries(
  AVATARS.map((a) => [a, [...HEAD[a], ...BODY].map(pad)]),
) as Record<Avatar, string[]>;

export interface Palette {
  h: string;
  s: string;
  b: string;
  t: string;
  e: string;
  d: string;
  w: string;
}

export const PALETTES: Record<Avatar, Palette> = {
  wizard: {
    h: "#5b3fd1",
    s: "#f2c9a0",
    b: "#3b82f6",
    t: "#fcd34d",
    e: "#111827",
    d: "#1e1b4b",
    w: "#a78bfa",
  },
  scout: {
    h: "#166534",
    s: "#e8b88a",
    b: "#22c55e",
    t: "#a16207",
    e: "#111827",
    d: "#14532d",
    w: "#92400e",
  },
  rogue: {
    h: "#3f3f46",
    s: "#d9a67a",
    b: "#52525b",
    t: "#ef4444",
    e: "#111827",
    d: "#18181b",
    w: "#d4d4d8",
  },
  knight: {
    h: "#9ca3af",
    s: "#f2c9a0",
    b: "#d1d5db",
    t: "#dc2626",
    e: "#111827",
    d: "#374151",
    w: "#e5e7eb",
  },
  cleric: {
    h: "#f5f5f4",
    s: "#f2c9a0",
    b: "#fafafa",
    t: "#facc15",
    e: "#111827",
    d: "#78716c",
    w: "#fde68a",
  },
  bard: {
    h: "#be185d",
    s: "#f2c9a0",
    b: "#ec4899",
    t: "#38bdf8",
    e: "#111827",
    d: "#500724",
    w: "#fbbf24",
  },
};

export function resolveAvatar(avatar: string): Avatar {
  return (AVATARS as readonly string[]).includes(avatar) ? (avatar as Avatar) : "wizard";
}

/** Draw a grid to a canvas (one canvas pixel per grid cell). */
export function renderGridToCanvas(avatar: Avatar): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const palette = PALETTES[avatar];
  SPRITE_GRIDS[avatar].forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const fill = palette[ch as keyof Palette];
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, 1, 1);
      }
    });
  });
  return canvas;
}

/** Create a nearest-neighbour texture for an avatar. Caller owns (and must destroy) it. */
export function createAvatarTexture(avatar: string): Texture {
  const texture = Texture.from(renderGridToCanvas(resolveAvatar(avatar)), true);
  texture.source.scaleMode = "nearest";
  return texture;
}
