"use client";
import { useEffect, useRef } from "react";
import { Application, Container, Graphics, Sprite, Text, type Texture } from "pixi.js";
import type { AgentState } from "@/lib/client/questReducer";
import { orderAgents, seatPositions, spriteScale, tableGeometry } from "./layout";
import { createAvatarTexture, SPRITE_SIZE } from "./sprites";

interface SeatView {
  root: Container;
  body: Container;
  sprite: Sprite;
  flash: Graphics;
  label: Text;
  hp: Graphics;
  avatar: string;
}

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

export default function PixiStage({ agents }: { agents: AgentState[] }) {
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
      if (disposed || !ready || !layer || !bg) return;
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
          seats.delete(id);
        }
      }
      ordered.forEach((a, i) => {
        let v = seats.get(a.id);
        if (v && v.avatar !== a.avatar) {
          v.root.destroy({ children: true });
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
          body.addChild(sprite, flash);
          root.addChild(body, label, hp);
          layer!.addChild(root);
          v = { root, body, sprite, flash, label, hp, avatar: a.avatar };
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
          v.flash.rect(-px / 2, -px, px, px).fill({ color: 0xdc2626, alpha: reduced ? 0.4 : 0 });
        }
        v.body.position.set(0, 0);
        v.flash.alpha = 1;
        if (reduced) v.body.position.set(0, 0);
      });
    }
    updateRef.current = update;

    function tick(ticker: { deltaMS: number }) {
      if (reduced) return;
      elapsed += ticker.deltaMS / 1000;
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
          v.flash.alpha = 0.5 + 0.5 * Math.sin(elapsed * 10);
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
        app.stage.addChild(bg, layer);
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
            {a.role}: {a.status}, {Math.round(a.remainingRatio * 100)}% budget remaining
          </li>
        ))}
      </ul>
    </div>
  );
}
