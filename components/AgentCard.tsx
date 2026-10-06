import { AVATAR_GLYPH, type MockAgent } from "./mock-data";

const STATUS_STYLE: Record<MockAgent["status"], string> = {
  THINKING: "bg-amber-400 text-black",
  SEARCHING: "bg-sky-400 text-black",
  SPEAKING: "bg-emerald-400 text-black",
  PAUSED: "bg-zinc-400 text-black",
  DONE: "bg-violet-400 text-black",
  ERROR: "bg-red-500 text-white",
};

export function HpBar({ used, budget }: { used: number; budget: number }) {
  const ratio = Math.max(0, Math.min(1, 1 - used / budget));
  const color = ratio > 0.5 ? "bg-emerald-500" : ratio > 0.2 ? "bg-amber-400" : "bg-red-500";
  return (
    <div
      role="progressbar"
      aria-label="Token budget remaining"
      aria-valuemin={0}
      aria-valuemax={budget}
      aria-valuenow={budget - used}
      className="h-2.5 w-full border-2 border-black bg-zinc-800"
    >
      <div
        className={`h-full ${color} transition-[width] motion-reduce:transition-none`}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}

export function StatusBadge({ status }: { status: MockAgent["status"] }) {
  return (
    <span
      className={`inline-block px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_STYLE[status]}`}
    >
      {status}
    </span>
  );
}

/** Full card at sm+, compact status row on narrow screens (README §10 rule 4). */
export function AgentCard({ agent }: { agent: MockAgent }) {
  const glyph = AVATAR_GLYPH[agent.avatar] ?? "❓";
  return (
    <li
      data-testid="agent-card"
      className="border-4 border-amber-200/80 bg-indigo-950/80 shadow-[4px_4px_0_0_#000]"
    >
      {/* compact row */}
      <div className="flex min-h-11 items-center gap-2 px-2 py-1 sm:hidden" data-testid="agent-row">
        <span aria-hidden className="text-xl">
          {glyph}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-bold">{agent.role}</span>
            <StatusBadge status={agent.status} />
          </div>
          <HpBar used={agent.tokensUsed} budget={agent.tokenBudget} />
        </div>
      </div>
      {/* full card */}
      <div className="hidden space-y-2 p-3 sm:block">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="grid size-12 place-items-center border-2 border-black bg-indigo-900 text-3xl"
          >
            {glyph}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-bold">{agent.role}</div>
            <StatusBadge status={agent.status} />
          </div>
        </div>
        <HpBar used={agent.tokensUsed} budget={agent.tokenBudget} />
        <div className="text-[10px] text-indigo-200">
          {agent.tokensUsed.toLocaleString()} / {agent.tokenBudget.toLocaleString()} tokens
        </div>
        <p className="border-2 border-black bg-black/40 p-2 text-sm italic">“{agent.latestLine}”</p>
      </div>
    </li>
  );
}
