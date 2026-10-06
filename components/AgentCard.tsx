import { AVATAR_GLYPH } from "./mock-data";
import { statusLabel } from "./arena/statusLabels";
import type { AgentState, AgentStatus, InspectSelection } from "@/lib/client/questReducer";

const STATUS_STYLE: Record<AgentStatus, string> = {
  IDLE: "bg-zinc-600 text-white",
  FACT_CHECKING: "bg-orange-400 text-black",
  FALLBACK: "bg-fuchsia-400 text-black",
  CONSENSUS: "bg-teal-300 text-black",
  THINKING: "bg-amber-400 text-black",
  SEARCHING: "bg-sky-400 text-black",
  SPEAKING: "bg-emerald-400 text-black",
  PAUSED: "bg-zinc-400 text-black",
  DONE: "bg-violet-400 text-black",
  ERROR: "bg-red-500 text-white",
};

export function HpBar({ ratio: raw }: { ratio: number }) {
  const ratio = Math.max(0, Math.min(1, raw));
  const color = ratio > 0.5 ? "bg-emerald-500" : ratio > 0.2 ? "bg-amber-400" : "bg-red-500";
  return (
    <div
      role="progressbar"
      aria-label="Token budget remaining"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      className="h-2.5 w-full border-2 border-black bg-zinc-800"
    >
      <div
        className={`h-full ${color} transition-[width] motion-reduce:transition-none`}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}

export function StatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span
      className={`inline-block px-1.5 py-0.5 text-[10px] font-bold tracking-wider ${STATUS_STYLE[status]}`}
    >
      {statusLabel(status)}
    </span>
  );
}

/** Full card at sm+, compact status row on narrow screens (README §10 rule 4). */
export function AgentCard({
  agent: raw,
  paused = false,
  onInspect,
}: {
  agent: AgentState;
  paused?: boolean;
  onInspect?: (sel: InspectSelection) => void;
}) {
  const agent: AgentState =
    paused && raw.status !== "DONE" && raw.status !== "ERROR" ? { ...raw, status: "PAUSED" } : raw;
  const glyph = AVATAR_GLYPH[agent.avatar] ?? "❓";
  return (
    <li
      data-testid="agent-card"
      className="border-4 border-amber-200/80 bg-indigo-950/80 shadow-[4px_4px_0_0_#000]"
    >
      {/* compact row */}
      <div
        className="flex min-h-11 items-center gap-2 px-2 py-1 sm:hidden"
        data-testid="agent-row"
        {...(onInspect
          ? {
              role: "button",
              tabIndex: 0,
              "aria-label": `Inspect ${agent.role}`,
              onClick: () => onInspect({ agentId: agent.id }),
              onKeyDown: (ev: React.KeyboardEvent) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onInspect({ agentId: agent.id });
                }
              },
            }
          : {})}
      >
        <span aria-hidden className="text-xl">
          {glyph}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-bold">{agent.role}</span>
            <StatusBadge status={agent.status} />
          </div>
          <HpBar ratio={agent.remainingRatio} />
        </div>
      </div>
      {/* full card */}
      <div className="hidden space-y-2 p-3 sm:block">
        {onInspect && (
          <button
            type="button"
            data-testid="agent-inspect"
            onClick={() => onInspect({ agentId: agent.id })}
            className="float-right min-h-8 px-2 text-[10px] uppercase text-amber-300 underline"
          >
            Inspect
          </button>
        )}
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
        <HpBar ratio={agent.remainingRatio} />
        <div className="text-[10px] text-indigo-200">
          {agent.tokensUsed.toLocaleString()} tokens
          {(agent.modelUsed ?? agent.model) && <> · {agent.modelUsed ?? agent.model}</>}
          {agent.fallback && <span className="text-fuchsia-300"> · fallback</span>}
        </div>
        {agent.latestLine && (
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap border-2 border-black bg-black/40 p-2 text-sm italic">
            “{agent.latestLine}”
          </p>
        )}
      </div>
    </li>
  );
}
