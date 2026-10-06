import { Stage } from "./arena/Stage";
import { AgentCard } from "./AgentCard";
import type { AgentState } from "@/lib/client/questReducer";

export function ArenaPanel({ agents, paused = false }: { agents: AgentState[]; paused?: boolean }) {
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
      {agents.length > 0 && (
        <div className="hidden sm:block">
          <Stage
            agents={agents.map((a) =>
              paused && a.status !== "DONE" && a.status !== "ERROR"
                ? { ...a, status: "PAUSED" as const }
                : a,
            )}
          />
        </div>
      )}
      <ul className="grid grid-cols-1 gap-3 sm:hidden">
        {agents.map((a) => (
          <AgentCard key={a.id} agent={a} paused={paused} />
        ))}
      </ul>
    </div>
  );
}
