"use client";
import { useEffect, useRef, useState } from "react";
import { Application, Container, Graphics, Sprite, Text, type Texture } from "pixi.js";
import type { AgentState } from "@/lib/client/questReducer";
import { orderAgents, seatPositions, spriteScale, tableGeometry } from "./layout";
import { placeBubble, truncateLine, type Rect } from "./bubbles";
import { badgeText, statusLabel } from "./statusLabels";
import { createAvatarTexture, SPRITE_SIZE } from "./sprites";

interface SeatView {
  root: Container;
  body: Container;
  sprite: Sprite;
  flash: Graphics;
  label: Text;
  hp: Graphics;
  avatar: string;
  badge: Container;
  badgeBg: Graphics;
  badgeLabel: Text;
  badgeKey: string;
  tag: Text;
  fx: Graphics;
  bubble: Container;
  bubbleGfx: Graphics;
  bubbleText: Text;
  line: string;
  bubbleT: number;
  fallbackKey: string;
  fallbackT: number;
}

const BUBBLE_PAD = 6;
const FALLBACK_FX_SECONDS = 0.9;

function shortModel(m: string): string {
  const name = m.includes("/") ? m.slice(m.indexOf("/") + 1) : m;
  return name.length > 18 ? name.slice(0, 17) + "…" : name;
}

function drawPixelBox(g: Graphics, w: number, h: number, tailX: number, below: boolean) {
  const notch = (x: number, y: number, bw: number, bh: number, color: number) => {
    g.rect(x + 2, y, bw - 4, bh).fill(color);
    g.rect(x, y + 2, bw, bh - 4).fill(color);
  };
  g.clear();
  notch(0, 0, w, h, 0x000000);
  notch(2, 2, w - 4, h - 4, 0xfef3c7);
  const tx = Math.round(Math.max(4, Math.min(w - 12, tailX - 4)));
  if (below) {
    g.rect(tx, -4, 8, 4).fill(0x000000);
    g.rect(tx + 2, -2, 4, 4).fill(0xfef3c7);
  } else {
    g.rect(tx, h, 8, 4).fill(0x000000);
    g.rect(tx + 2, h - 2, 4, 4).fill(0xfef3c7);
  }
}

function drawBadge(bg: Graphics, label: Text, color: number) {
  const w = Math.ceil(label.width) + 8;
  const h = Math.ceil(label.height) + 4;
  bg.clear();
  bg.rect(-w / 2 - 1, -h / 2 - 1, w + 2, h + 2).fill(0x000000);
  bg.rect(-w / 2, -h / 2, w, h).fill(color);
}

const BADGE_COLOR: Record<string, number> = {
  THINKING: 0xfbbf24,
  SEARCHING: 0x38bdf8,
  SPEAKING: 0x34d399,
  FACT_CHECKING: 0xfb923c,
  CONSENSUS: 0x5eead4,
  FALLBACK: 0xe879f9,
  PAUSED: 0xa1a1aa,
  DONE: 0xa78bfa,
  ERROR: 0xef4444,
  IDLE: 0x52525b,
};

const BAR_W = 40;
const BAR_H = 5;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function drawBackground(g: Graphics, w: number, h: number) {
  g.clear();
  const tile = Math.max(16, Math.round(Math.min(w, h) / 12));
  for (let ty = 0; ty * tile < h; ty++) {
    for (let tx = 0; tx * tile < w; tx++) {
      g.rect(tx * tile, ty * tile, tile, tile).fill((tx + ty) % 2 === 0 ? 0x1e1b4b : 0x272264);
    }
  }
  const t = tableGeometry(w, h);
  g.ellipse(t.cx, t.cy + 6, t.rx + 8, t.ry + 8).fill(0x000000);
  g.ellipse(t.cx, t.cy, t.rx + 6, t.ry + 6).fill(0x451a03);
  g.ellipse(t.cx, t.cy, t.rx, t.ry).fill(0x78350f);
  g.ellipse(t.cx, t.cy, t.rx * 0.7, t.ry * 0.7).stroke({ width: 2, color: 0x92400e });
}

function drawHp(g: Graphics, ratio: number) {
  const r = Math.max(0, Math.min(1, ratio));
  const color = r > 0.5 ? 0x10b981 : r > 0.2 ? 0xfbbf24 : 0xef4444;
  g.clear();
  g.rect(-BAR_W / 2 - 1, -1, BAR_W + 2, BAR_H + 2).fill(0x000000);
  g.rect(-BAR_W / 2, 0, BAR_W, BAR_H).fill(0x27272a);
  if (r > 0) g.rect(-BAR_W / 2, 0, Math.max(1, Math.round(BAR_W * r)), BAR_H).fill(color);
}

/** Id of the agent whose latestLine changed most recently (null if none yet). */
export function trackSpeaker(
  prev: { lines: Record<string, string>; speaker: string | null },
  agents: AgentState[],
): { lines: Record<string, string>; speaker: string | null } {
  let speaker = prev.speaker;
  const lines: Record<string, string> = {};
  for (const a of agents) {
    lines[a.id] = a.latestLine;
    if (a.latestLine && prev.lines[a.id] !== a.latestLine) speaker = a.id;
  }
  return { lines, speaker };
}

export default function PixiStage({ agents }: { agents: AgentState[] }) {
  const [tracked, setTracked] = useState<{ lines: Record<string, string>; speaker: string | null }>(
    () => trackSpeaker({ lines: {}, speaker: null }, agents),
  );
  const next = trackSpeaker(tracked, agents);
  if (next.speaker !== tracked.speaker || JSON.stringify(next.lines) !== JSON.stringify(tracked.lines))
    setTracked(next);
  const hostRef = useRef<HTMLDivElement>(null);
  const agentsRef = useRef(agents);
  const updateRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    agentsRef.current = agents;
    updateRef.current?.();
  }, [agents]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let ready = false;
    const app = new Application();
    const textures = new Map<string, Texture>();
    const seats = new Map<string, SeatView>();
    let reduced = prefersReducedMotion();
    let mq: MediaQueryList | null = null;
    const onMq = (e: MediaQueryListEvent) => {
      reduced = e.matches;
      update();
    };
    let elapsed = 0;
    let bg: Graphics | null = null;
    let layer: Container | null = null;
    let bubbleLayer: Container | null = null;
    let bgSize = "";

    const textureFor = (avatar: string) => {
      let t = textures.get(avatar);
      if (!t) {
        t = createAvatarTexture(avatar);
        textures.set(avatar, t);
      }
      return t;
    };

    function update() {
      if (disposed || !ready || !layer || !bg || !bubbleLayer) return;
      const w = app.screen.width;
      const h = app.screen.height;
      if (w <= 0 || h <= 0) return;
      const size = `${w}x${h}`;
      if (size !== bgSize) {
        drawBackground(bg, w, h);
        bgSize = size;
      }
      const ordered = orderAgents(agentsRef.current);
      const pos = seatPositions(ordered.length, w, h);
      const scale = spriteScale(w, h, ordered.length);
      const live = new Set(ordered.map((a) => a.id));
      for (const [id, v] of seats) {
        if (!live.has(id)) {
          v.root.destroy({ children: true });
          v.bubble.destroy({ children: true });
          seats.delete(id);
        }
      }
      const taken: Rect[] = [];
      const sprites: Rect[] = [];
      ordered.forEach((_, i) => {
        const px = SPRITE_SIZE * scale;
        sprites.push({ x: pos[i].x - px / 2, y: pos[i].y - px - 22, w: px, h: px + 22 + 40 });
      });
      ordered.forEach((a, i) => {
        let v = seats.get(a.id);
        if (v && v.avatar !== a.avatar) {
          v.root.destroy({ children: true });
          v.bubble.destroy({ children: true });
          seats.delete(a.id);
          v = undefined;
        }
        if (!v) {
          const root = new Container();
          const body = new Container();
          const sprite = new Sprite(textureFor(a.avatar));
          sprite.anchor.set(0.5, 1);
          const flash = new Graphics();
          const label = new Text({
            text: a.role,
            style: { fontFamily: "monospace", fontSize: 11, fontWeight: "bold", fill: 0xfef3c7 },
          });
          label.anchor.set(0.5, 0);
          const hp = new Graphics();
          const fx = new Graphics();
          const badge = new Container();
          const badgeBg = new Graphics();
          const badgeLabel = new Text({
            text: "",
            style: { fontFamily: "monospace", fontSize: 10, fontWeight: "bold", fill: 0x111111 },
          });
          badgeLabel.anchor.set(0.5);
          badge.addChild(badgeBg, badgeLabel);
          const tag = new Text({
            text: "",
            style: { fontFamily: "monospace", fontSize: 9, fontWeight: "bold", fill: 0xf0abfc },
          });
          tag.anchor.set(0.5, 0);
          const bubble = new Container();
          const bubbleGfx = new Graphics();
          const bubbleText = new Text({
            text: "",
            style: {
              fontFamily: "monospace",
              fontSize: 10,
              fontWeight: "bold",
              fill: 0x1c1917,
              wordWrap: true,
              wordWrapWidth: 140,
              lineHeight: 12,
            },
          });
          bubbleText.position.set(BUBBLE_PAD, BUBBLE_PAD);
          bubble.addChild(bubbleGfx, bubbleText);
          bubble.visible = false;
          bubbleLayer!.addChild(bubble);
          body.addChild(sprite, flash);
          root.addChild(body, fx, label, hp, tag, badge);
          layer!.addChild(root);
          v = {
            root, body, sprite, flash, label, hp, avatar: a.avatar,
            badge, badgeBg, badgeLabel, badgeKey: "", tag, fx, bubble, bubbleGfx, bubbleText,
            line: "", bubbleT: 0, fallbackKey: "", fallbackT: 0,
          };
          seats.set(a.id, v);
        }
        const px = SPRITE_SIZE * scale;
        v.root.position.set(Math.round(pos[i].x), Math.round(pos[i].y));
        v.sprite.scale.set(scale);
        v.sprite.position.set(0, 0);
        v.label.text = a.role;
        v.label.position.set(0, 4);
        v.hp.position.set(0, 4 + 16);
        drawHp(v.hp, a.remainingRatio);
        const dim = a.status === "PAUSED" || a.status === "DONE";
        v.body.alpha = dim ? 0.5 : 1;
        v.sprite.tint = dim ? 0x888888 : 0xffffff;
        v.flash.clear();
        if (a.status === "ERROR") {
          v.flash.rect(-px / 2, -px, px, px).fill({ color: 0xdc2626, alpha: 0.5 });
        }
        v.body.position.set(0, 0);

        // Status badge above the avatar.
        const bText = badgeText(a.status, elapsed, reduced);
        if (v.badgeKey !== bText) {
          v.badgeKey = bText;
          v.badgeLabel.text = bText;
          drawBadge(v.badgeBg, v.badgeLabel, BADGE_COLOR[a.status] ?? 0xffffff);
        }
        v.badge.position.set(0, -px - 12);

        // Fallback tag + swap effect.
        if (a.fallback) {
          v.tag.text = `🔄 ${shortModel(a.fallback.modelUsed)}`;
          v.tag.position.set(0, 4 + 16 + 8);
          v.tag.visible = true;
          const key = `${a.fallback.primary}>${a.fallback.modelUsed}`;
          if (v.fallbackKey !== key) {
            v.fallbackKey = key;
            v.fallbackT = reduced ? 0 : FALLBACK_FX_SECONDS;
          }
        } else {
          v.tag.visible = false;
          v.fallbackKey = "";
          v.fallbackT = 0;
        }

        // Speech bubble.
        const line = truncateLine(a.latestLine);
        if (!line) {
          v.bubble.visible = false;
          v.line = "";
        } else {
          if (line !== v.line) {
            v.line = line;
            v.bubbleT = reduced ? 1 : 0;
          }
          v.bubbleText.style.wordWrapWidth = Math.max(60, Math.min(150, w * 0.4) - BUBBLE_PAD * 2);
          v.bubbleText.text = line;
          const bw = Math.ceil(v.bubbleText.width) + BUBBLE_PAD * 2;
          const bh = Math.ceil(v.bubbleText.height) + BUBBLE_PAD * 2;
          const avoid = [...taken, ...sprites.filter((_, j) => j !== i)];
          const pl = placeBubble({
            anchorX: pos[i].x,
            anchorTop: pos[i].y - px - 24,
            anchorBottom: pos[i].y + 4 + 16 + 10,
            bw,
            bh,
            stageW: w,
            stageH: h,
            avoid,
          });
          taken.push(pl);
          drawPixelBox(v.bubbleGfx, pl.w, pl.h, pl.tailX - pl.x, pl.below);
          v.bubble.pivot.set(pl.w / 2, pl.h / 2);
          v.bubble.position.set(Math.round(pl.x + pl.w / 2), Math.round(pl.y + pl.h / 2));
          v.bubble.visible = true;
          const t = reduced ? 1 : v.bubbleT;
          v.bubble.alpha = t;
          v.bubble.scale.set(0.7 + 0.3 * t);
        }
      });
    }
    updateRef.current = update;

    function tick(ticker: { deltaMS: number }) {
      if (reduced) return;
      const dt = ticker.deltaMS / 1000;
      elapsed += dt;
      for (const v of seats.values()) {
        if (v.bubble.visible && v.bubbleT < 1) {
          v.bubbleT = Math.min(1, v.bubbleT + dt / 0.2);
          v.bubble.alpha = v.bubbleT;
          v.bubble.scale.set(0.7 + 0.3 * v.bubbleT);
        }
        v.fx.clear();
        if (v.fallbackT > 0) {
          v.fallbackT = Math.max(0, v.fallbackT - dt);
          const k = 1 - v.fallbackT / FALLBACK_FX_SECONDS;
          const px = v.sprite.height;
          v.fx.rect(-px / 2, -px, px, px).fill({ color: 0xe879f9, alpha: 0.5 * (1 - k) });
          for (let n = 0; n < 8; n++) {
            const ang = (n / 8) * Math.PI * 2 + k * 2;
            const r = (px / 2) * (0.4 + k);
            v.fx
              .rect(Math.round(Math.cos(ang) * r) - 2, Math.round(-px / 2 + Math.sin(ang) * r) - 2, 4, 4)
              .fill({ color: 0xf0abfc, alpha: 1 - k });
          }
        }
        if (v.badgeKey.startsWith("Thinking")) {
          const a = agentsRef.current.find((x) => seats.get(x.id) === v);
          if (a) {
            const t = badgeText(a.status, elapsed, false);
            if (t !== v.badgeKey) {
              v.badgeKey = t;
              v.badgeLabel.text = t;
              drawBadge(v.badgeBg, v.badgeLabel, BADGE_COLOR.THINKING);
            }
          }
        }
      }
      const ordered = orderAgents(agentsRef.current);
      ordered.forEach((a, i) => {
        const v = seats.get(a.id);
        if (!v) return;
        const phase = i * 0.9;
        let dy = 0;
        let dx = 0;
        if (a.status === "SPEAKING") dy = -Math.abs(Math.sin(elapsed * 8 + phase)) * 8;
        else if (a.status === "ERROR") dx = Math.sin(elapsed * 40) * 2;
        else if (a.status !== "PAUSED" && a.status !== "DONE")
          dy = Math.round(Math.sin(elapsed * 2.6 + phase) * 2);
        v.body.position.set(Math.round(dx), Math.round(dy));
        if (a.status === "ERROR") {
          v.flash.alpha = 0.6 + 0.4 * Math.sin(elapsed * 10);
        }
      });
    }

    app
      .init({
        resizeTo: host,
        antialias: false,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, 3),
        backgroundAlpha: 0,
        roundPixels: true,
      })
      .then(() => {
        if (disposed) {
          app.destroy(true, { children: true, texture: true });
          return;
        }
        ready = true;
        host.appendChild(app.canvas);
        app.canvas.setAttribute("aria-hidden", "true");
        app.canvas.style.imageRendering = "pixelated";
        app.canvas.style.display = "block";
        bg = new Graphics();
        layer = new Container();
        bubbleLayer = new Container();
        app.stage.addChild(bg, layer, bubbleLayer);
        app.renderer.on("resize", update);
        app.ticker.add(tick);
        mq = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
        mq?.addEventListener?.("change", onMq);
        update();
      })
      .catch(() => {
        /* WebGL unavailable: the DOM mirror still conveys state. */
      });

    return () => {
      disposed = true;
      updateRef.current = null;
      mq?.removeEventListener?.("change", onMq);
      if (ready) {
        app.ticker.remove(tick);
        app.renderer.off("resize", update);
        seats.clear();
        app.destroy(true, { children: true, texture: true });
        textures.forEach((t) => t.destroy(true));
        textures.clear();
      }
    };
  }, []);

  return (
    <div
      data-testid="arena-stage"
      className="relative mx-auto aspect-square w-full max-w-xl overflow-hidden border-4 border-amber-200/80 bg-indigo-950/80 shadow-[4px_4px_0_0_#000]"
    >
      <div ref={hostRef} aria-hidden className="absolute inset-0" />
      <ul className="sr-only" data-testid="stage-a11y-list">
        {orderAgents(agents).map((a) => (
          <li key={a.id}>
            {a.role}: {statusLabel(a.status)}, {Math.round(a.remainingRatio * 100)}% budget remaining
            {a.latestLine && (
              <span
                data-testid="stage-a11y-line"
                aria-live={a.id === tracked.speaker ? "polite" : undefined}
              >
                {" "}
                Latest: {truncateLine(a.latestLine)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
