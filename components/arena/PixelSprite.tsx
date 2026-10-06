const PX = 1;

interface Palette {
  hat: string;
  skin: string;
  body: string;
  trim: string;
}

const PALETTES: Record<string, Palette> = {
  wizard: { hat: "#5b3fd1", skin: "#f2c9a0", body: "#3b82f6", trim: "#fcd34d" },
  scout: { hat: "#166534", skin: "#e8b88a", body: "#22c55e", trim: "#a16207" },
  rogue: { hat: "#27272a", skin: "#d9a67a", body: "#52525b", trim: "#ef4444" },
  knight: { hat: "#9ca3af", skin: "#f2c9a0", body: "#d1d5db", trim: "#dc2626" },
  cleric: { hat: "#f5f5f4", skin: "#f2c9a0", body: "#fafafa", trim: "#facc15" },
  bard: { hat: "#be185d", skin: "#f2c9a0", body: "#ec4899", trim: "#38bdf8" },
};

/** 8x10 grid; letters map to palette entries, "." is transparent. */
const GRID = [
  "..hhhh..",
  ".hhhhhh.",
  ".hssssh.",
  ".sessse.",
  "..ssss..",
  ".bbttbb.",
  "sbbttbbs",
  "sbbbbbbs",
  ".bbbbbb.",
  ".dd..dd.",
];

function colorFor(ch: string, p: Palette): string | null {
  switch (ch) {
    case "h":
      return p.hat;
    case "s":
      return p.skin;
    case "b":
      return p.body;
    case "t":
      return p.trim;
    case "e":
      return "#111827";
    case "d":
      return "#1f2937";
    default:
      return null;
  }
}

export function PixelSprite({
  avatar,
  size = 64,
  className,
}: {
  avatar: string;
  size?: number;
  className?: string;
}) {
  const palette = PALETTES[avatar] ?? PALETTES.wizard;
  const rects: React.ReactNode[] = [];
  GRID.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const fill = colorFor(ch, palette);
      if (fill)
        rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={PX} height={PX} fill={fill} />);
    });
  });
  return (
    <svg
      data-testid="pixel-sprite"
      data-avatar={avatar}
      viewBox="0 0 8 10"
      width={size}
      height={(size * 10) / 8}
      shapeRendering="crispEdges"
      style={{ imageRendering: "pixelated" }}
      role="img"
      aria-label={`${avatar} sprite`}
      className={className}
    >
      {rects}
    </svg>
  );
}
