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
  /** Set when the bubble sits beside the sprite: which side of the sprite it is on. */
  side: "left" | "right" | null;
  /** Tail x, in stage coordinates, clamped inside the bubble (above/below placements). */
  tailX: number;
  /** Tail y, in stage coordinates, clamped inside the bubble (side placements). */
  tailY: number;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Place a bubble of size (bw, bh) near an anchor. Prefers above `anchorTop`; when `sprite` is
 * given, side placements (right, then left) are also tried, and are preferred when `preferSide`
 * is set or the above placement would be clipped by the stage top. Picks the first candidate that
 * fits inside the stage without overlapping `avoid` (falls back to least overlap). The result
 * is always fully inside the stage.
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
  /** Sprite rect (enables side placements). */
  sprite?: Rect;
  preferSide?: boolean;
}): BubblePlacement {
  const { anchorX, anchorTop, anchorBottom, stageW, stageH, sprite } = opts;
  const margin = opts.margin ?? 4;
  const gap = opts.gap ?? 6;
  const avoid = opts.avoid ?? [];
  const bw = Math.min(opts.bw, Math.max(0, stageW - margin * 2));
  const bh = Math.min(opts.bh, Math.max(0, stageH - margin * 2));
  const maxX = Math.max(margin, stageW - bw - margin);
  const maxY = Math.max(margin, stageH - bh - margin);
  const x = clamp(anchorX - bw / 2, margin, maxX);
  type Cand = { p: BubblePlacement; exact: boolean };
  const vertical = (below: boolean): Cand => {
    const rawY = below ? anchorBottom + gap : anchorTop - gap - bh;
    const y = clamp(rawY, margin, maxY);
    return {
      p: { x, y, w: bw, h: bh, below, side: null, tailX: clamp(anchorX, x + 6, x + bw - 6), tailY: y },
      exact: y === rawY,
    };
  };
  const sideCand = (side: "left" | "right"): Cand | null => {
    if (!sprite) return null;
    const rawX = side === "right" ? sprite.x + sprite.w + gap : sprite.x - gap - bw;
    const cx = sprite.y + sprite.h / 2;
    const rawY = cx - bh / 2;
    const px = clamp(rawX, margin, maxX);
    const y = clamp(rawY, margin, maxY);
    return {
      p: { x: px, y, w: bw, h: bh, below: false, side, tailX: px, tailY: clamp(cx, y + 6, y + bh - 6) },
      exact: px === rawX,
    };
  };
  const above = vertical(false);
  const below = vertical(true);
  const right = sideCand("right");
  const left = sideCand("left");
  const sideFirst = !!sprite && (opts.preferSide || !above.exact);
  const list = (
    sideFirst ? [right, left, below, above] : [above, below, right, left]
  ).filter((c): c is Cand => c !== null);
  const score = (p: BubblePlacement) => avoid.reduce((n, r) => n + (rectsOverlap(p, r) ? 1 : 0), 0);
  const fit = list.find((c) => c.exact && score(c.p) === 0);
  if (fit) return fit.p;
  let best = list[0];
  let bestScore = score(best.p);
  for (const c of list.slice(1)) {
    const sc = score(c.p);
    if (sc < bestScore) {
      best = c;
      bestScore = sc;
    }
  }
  return best.p;
}
