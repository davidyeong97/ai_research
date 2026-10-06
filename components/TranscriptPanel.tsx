import type { TranscriptEntry } from "@/lib/client/questReducer";

const KIND_STYLE: Record<TranscriptEntry["kind"], string> = {
  message: "border-amber-200/60 bg-indigo-950/80",
  status: "border-indigo-400/40 bg-indigo-950/50 italic text-indigo-200",
  final: "border-amber-300 bg-amber-300/20 shadow-[3px_3px_0_0_#000]",
  error: "border-red-500 bg-red-950/60 text-red-100",
};

export function TranscriptPanel({ entries }: { entries: TranscriptEntry[] }) {
  return (
    <div className="h-full overflow-y-auto overscroll-contain p-3" data-testid="transcript-scroll">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-amber-300">
        Discussion Stream
      </h2>
      {entries.length === 0 && <p className="text-sm text-indigo-300">Nothing said yet.</p>}
      <ol className="space-y-2">
        {entries.map((e) => (
          <li
            key={e.id}
            data-testid={e.kind === "final" ? "final-answer" : "transcript-entry"}
            className={`border-2 p-2 text-sm ${KIND_STYLE[e.kind]}`}
          >
            <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-indigo-300">
              <span>{e.kind === "final" ? "🏆 Final answer" : `R${e.round} · ${e.agentId}`}</span>
              <span>{e.action}</span>
            </div>
            <p className="whitespace-pre-wrap break-words">{e.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
