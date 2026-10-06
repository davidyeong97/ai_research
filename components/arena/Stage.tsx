"use client";
import type { TargetAndTransition, Transition } from "framer-motion";

import { motion, useReducedMotion } from "framer-motion";
import type { AgentState } from "@/lib/client/questReducer";
import { HpBar } from "../AgentCard";
import { PixelSprite } from "./PixelSprite";

/** Seat positions (percent) around the table; lead sits at the head (top). */
export function seatPositions(count: number): { x: number; y: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(count, 1);
    return { x: 50 + 38 * Math.cos(angle), y: 46 + 36 * Math.sin(angle) };
  });
}

export function orderAgents(agents: AgentState[]): AgentState[] {
  const lead = agents.filter((a) => a.id === "lead");
  return [...lead, ...agents.filter((a) => a.id !== "lead")];
}

function Seat({
  agent,
  pos,
  reduced,
}: {
  agent: AgentState;
  pos: { x: number; y: number };
  reduced: boolean;
}) {
  const { status } = agent;
  const dim = status === "PAUSED" || status === "DONE";
  let animate: TargetAndTransition = {};
  let transition: Transition = {};
  if (!reduced) {
    if (status === "SPEAKING") {
      animate = { y: [0, -10, 0] };
      transition = { duration: 0.5, repeat: Infinity, ease: "easeOut" };
    } else if (status === "ERROR") {
      animate = { x: [0, -3, 3, -3, 0] };
      transition = { duration: 0.4, repeat: Infinity };
    } else if (!dim) {
      animate = { y: [0, -3, 0] };
      transition = { duration: 2.4, repeat: Infinity, ease: "easeInOut" };
    }
  }
  return (
    <div
      data-testid="stage-seat"
      data-status={status}
      className="absolute flex w-24 -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
      style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
    >
      <motion.div
        animate={animate}
        transition={transition}
        className={`relative ${dim ? "opacity-50 grayscale" : ""}`}
      >
        <PixelSprite avatar={agent.avatar} size={48} />
        {status === "ERROR" && (
          <motion.div
            data-testid="error-flash"
            aria-hidden
            className="absolute inset-0 bg-red-600 mix-blend-multiply"
            initial={{ opacity: reduced ? 0.4 : 0 }}
            animate={reduced ? { opacity: 0.4 } : { opacity: [0, 0.7, 0] }}
            transition={reduced ? undefined : { duration: 0.8, repeat: Infinity }}
          />
        )}
      </motion.div>
      <span className="max-w-full truncate text-[10px] font-bold text-amber-100">{agent.role}</span>
      <div className="w-full">
        <HpBar ratio={agent.remainingRatio} />
      </div>
    </div>
  );
}

export function Stage({ agents }: { agents: AgentState[] }) {
  const reduced = useReducedMotion() ?? false;
  const ordered = orderAgents(agents);
  const seats = seatPositions(ordered.length);
  return (
    <div
      data-testid="arena-stage"
      className="relative mx-auto aspect-square w-full max-w-xl border-4 border-amber-200/80 bg-indigo-950/80 shadow-[4px_4px_0_0_#000]"
    >
      <div
        aria-hidden
        className="absolute left-1/2 top-[46%] size-[44%] -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-black bg-amber-900 shadow-[inset_0_0_0_4px_#78350f]"
      />
      {ordered.map((a, i) => (
        <Seat key={a.id} agent={a} pos={seats[i]} reduced={reduced} />
      ))}
    </div>
  );
}
