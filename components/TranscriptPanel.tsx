import type { CouncilEvent } from "@/lib/shared";

export function TranscriptPanel({ events }: { events: CouncilEvent[] }) {
  return (
    <div className="h-full overflow-y-auto overscroll-contain p-3" data-testid="transcript-scroll">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-amber-300">
        Discussion Stream
      </h2>
      <ol className="space-y-2">
        {events.map((e) => (
          <li key={e.id} className="border-2 border-amber-200/60 bg-indigo-950/80 p-2 text-sm">
            <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-indigo-300">
              <span>
                R{e.round} · {e.agentId}
              </span>
              <span>{e.action}</span>
            </div>
            <p>{String(e.data.text ?? "")}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
