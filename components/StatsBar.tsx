import type { QuestState } from "@/lib/client/questReducer";
import { AgentBadge } from "./AgentBadge";
import { SoundToggle } from "./SoundToggle";

export type PhaseLabel = "Planning" | "Debating" | "Paused" | "Verdict" | "Error" | "Idle";

export function derivePhase(s: QuestState): PhaseLabel {
  if (s.phase === "error") return "Error";
  if (s.phase === "done") return s.finalAnswer ? "Verdict" : "Idle";
  if (s.phase === "idle") return "Idle";
  if (s.paused) return "Paused";
  if (s.pendingApproval || s.currentRound === 0) return "Planning";
  return "Debating";
}

export function runningCost(s: QuestState): number {
  if (s.phase === "done" && s.totalCostUsd > 0) return s.totalCostUsd;
  return s.agents.reduce((n, a) => n + a.costUsd, 0);
}

export function StatsBar({
  state,
  onOpenMemory,
}: {
  state: QuestState;
  onOpenMemory?: () => void;
}) {
  if (state.phase === "idle" && !state.plan) return null;
  const cap = state.plan?.budgetCapTokens ?? 0;
  const used =
    state.phase === "done" && state.totalTokens > 0
      ? state.totalTokens
      : state.agents.reduce((n, a) => n + a.tokensUsed, 0);
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const maxRounds = state.plan?.executionPlan.maxRounds;
  const phase = derivePhase(state);
  const color = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div
      data-testid="stats-bar"
      className="flex flex-none items-center gap-2 border-b-2 border-amber-200/40 bg-black/40 px-3 py-1 text-[11px] font-bold sm:text-xs"
    >
      <span data-testid="stats-round" className="flex-none whitespace-nowrap">
        R {Math.max(state.currentRound, 0)}
        {maxRounds ? `/${maxRounds}` : ""}
      </span>
      <div
        role="meter"
        aria-label="Token budget"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        title={`${used} / ${cap} tokens`}
        className="h-2.5 min-w-0 flex-1 border border-black bg-black/60"
      >
        <div
          className={`h-full ${color} transition-[width] motion-reduce:transition-none`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span data-testid="stats-cost" className="flex-none whitespace-nowrap">
        ${runningCost(state).toFixed(3)}
      </span>
      <span
        data-testid="stats-phase"
        className="flex-none whitespace-nowrap border border-black bg-amber-300 px-1.5 py-0.5 uppercase text-black"
      >
        {phase}
      </span>
      {state.recalled.length > 0 || state.transcript.some((t) => t.kind === "memory") ? (
        <button
          type="button"
          data-testid="stats-memory"
          aria-label={`Memory: ${state.recalled.length} recalled`}
          title="Memories recalled for this quest"
          onClick={onOpenMemory}
          className="flex min-h-11 min-w-11 flex-none items-center justify-center gap-0.5 border border-black bg-pink-300 px-1.5 text-black"
        >
          <span aria-hidden>🧠</span>
          <span>{state.recalled.length}</span>
        </button>
      ) : null}
      <AgentBadge source={state.source} />
      <SoundToggle />
    </div>
  );
}
