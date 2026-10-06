"use client";
import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import { AgentCard } from "./AgentCard";
import type { AgentState } from "@/lib/client/questReducer";

// Pixi touches window/WebGL, so it is only ever loaded in the browser.
const PixiStage = dynamic(() => import("./arena/PixiStage"), {
  ssr: false,
  loading: () => <div className="aspect-square w-full max-w-xl" aria-hidden />,
});

const QUERY = "(min-width: 640px)";

function subscribe(cb: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
function snapshot() {
  return typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
}
/** True at Tailwind `sm` and wider; false on the server and narrow viewports. */
export function useIsWide(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

export function ArenaPanel({ agents, paused = false }: { agents: AgentState[]; paused?: boolean }) {
  const wide = useIsWide();
  const shown = agents.map((a) =>
    paused && a.status !== "DONE" && a.status !== "ERROR" ? { ...a, status: "PAUSED" as const } : a,
  );
  return (
    <div className="h-full overflow-y-auto overscroll-contain p-3" data-testid="arena-scroll">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-amber-300">
        Visual Arena
      </h2>
      {agents.length === 0 && (
        <p className="text-sm text-indigo-300">
          No quest yet. Enter one below to summon the council.
        </p>
      )}
      {agents.length > 0 && wide && <PixiStage agents={shown} />}
      {agents.length > 0 && !wide && (
        <ul className="grid grid-cols-1 gap-3" data-testid="compact-rows">
          {agents.map((a) => (
            <AgentCard key={a.id} agent={a} paused={paused} />
          ))}
        </ul>
      )}
    </div>
  );
}
