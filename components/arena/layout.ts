export interface Point {
  x: number;
  y: number;
}

export interface TableGeometry {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** Round (elliptical) table centred in the stage, scaled to stage size. */
export function tableGeometry(width: number, height: number): TableGeometry {
  return { cx: width / 2, cy: height * 0.56, rx: width * 0.15, ry: height * 0.13 };
}

/**
 * Seat positions around the table. Seat 0 (the lead) is at the head (top, centre);
 * remaining seats go clockwise at equal angles. Seats sit on an ellipse just outside the table.
 */
export function seatPositions(count: number, width: number, height: number): Point[] {
  if (count <= 0) return [];
  const t = tableGeometry(width, height);
  const rx = Math.min(t.rx * 1.9, width * 0.42);
  const ry = Math.min(t.ry * 2.1, height * 0.38);
  return Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    return { x: t.cx + rx * Math.cos(angle), y: t.cy + ry * Math.sin(angle) };
  });
}

/** Lead first (head of the table), others keep their relative order. */
export function orderAgents<T extends { id: string }>(agents: T[]): T[] {
  return [...agents.filter((a) => a.id === "lead"), ...agents.filter((a) => a.id !== "lead")];
}

/** Integer sprite scale that keeps pixels crisp and fits the stage. */
export function spriteScale(width: number, height: number, count: number): number {
  const base = Math.min(width, height) / (count > 4 ? 120 : 100);
  return Math.max(2, Math.min(6, Math.floor(base)));
}
