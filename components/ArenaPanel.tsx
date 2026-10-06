import { AgentCard } from "./AgentCard";
import type { AgentState } from "@/lib/client/questReducer";

export function ArenaPanel({ agents }: { agents: AgentState[] }) {
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
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        {agents.map((a) => (
          <AgentCard key={a.id} agent={a} />
        ))}
      </ul>
    </div>
  );
}
