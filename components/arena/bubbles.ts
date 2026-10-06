export const BUBBLE_MAX_CHARS = 140;

/** Collapse whitespace and truncate to `max` chars with an ellipsis. */
export function truncateLine(text: string, max = BUBBLE_MAX_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BubblePlacement extends Rect {
  /** True when the bubble sits below the anchor (flipped). */
  below: boolean;
  /** Tail x, in stage coordinates, clamped inside the bubble. */
  tailX: number;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Place a bubble of size (bw, bh) near an anchor. Prefers above `anchorTop`, flips below
 * `anchorBottom` when there is no room (or when it collides), clamps inside the stage, and
 * picks the first candidate that avoids `avoid` rects (falls back to least overlap).
 */
export function placeBubble(opts: {
  anchorX: number;
  anchorTop: number;
  anchorBottom: number;
  bw: number;
  bh: number;
  stageW: number;
  stageH: number;
  avoid?: Rect[];
  margin?: number;
  gap?: number;
}): BubblePlacement {
  const { anchorX, anchorTop, anchorBottom, stageW, stageH } = opts;
  const margin = opts.margin ?? 4;
  const gap = opts.gap ?? 6;
  const avoid = opts.avoid ?? [];
  const bw = Math.min(opts.bw, Math.max(0, stageW - margin * 2));
  const bh = Math.min(opts.bh, Math.max(0, stageH - margin * 2));
  const x = clamp(anchorX - bw / 2, margin, Math.max(margin, stageW - bw - margin));
  const mk = (below: boolean): BubblePlacement => {
    const rawY = below ? anchorBottom + gap : anchorTop - gap - bh;
    const y = clamp(rawY, margin, Math.max(margin, stageH - bh - margin));
    return { x, y, w: bw, h: bh, below, tailX: clamp(anchorX, x + 6, x + bw - 6) };
  };
  const fitsAbove = anchorTop - gap - bh >= margin;
  const fitsBelow = anchorBottom + gap + bh <= stageH - margin;
  const order = fitsAbove || !fitsBelow ? [mk(false), mk(true)] : [mk(true), mk(false)];
  if (fitsAbove && !fitsBelow) order.splice(0, 2, mk(false), mk(true));
  const score = (p: BubblePlacement) =>
    avoid.reduce((n, r) => n + (rectsOverlap(p, r) ? 1 : 0), 0);
  let best = order[0];
  let bestScore = score(best);
  for (const c of order.slice(1)) {
    const s = score(c);
    if (s < bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}
