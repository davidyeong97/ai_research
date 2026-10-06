"use client";

import { useEffect, useRef } from "react";
import { Markdown } from "./Markdown";
import { FinalAnswer } from "./FinalAnswer";
import type { TranscriptEntry } from "@/lib/client/questReducer";

const KIND_STYLE: Record<TranscriptEntry["kind"], string> = {
  message: "border-amber-200/60 bg-indigo-950/80",
  status: "border-indigo-400/40 bg-indigo-950/50 italic text-indigo-200",
  final: "border-amber-300 bg-amber-300/20 shadow-[3px_3px_0_0_#000]",
  director: "border-sky-300 bg-sky-950/70 text-sky-50",
  error: "border-red-500 bg-red-950/60 text-red-100",
};

export function TranscriptPanel({
  entries,
  finalAnswer,
}: {
  entries: TranscriptEntry[];
  finalAnswer?: string | null;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [entries.length, finalAnswer]);
  const visible = finalAnswer ? entries.filter((e) => e.kind !== "final") : entries;
  return (
    <div className="h-full overflow-y-auto overscroll-contain p-3" data-testid="transcript-scroll">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-amber-300">
        Discussion Stream
      </h2>
      {visible.length === 0 && !finalAnswer && (
        <p className="text-sm text-indigo-300">Nothing said yet.</p>
      )}
      <ol className="space-y-2">
        {visible.map((e) => (
          <li
            key={e.id}
            data-testid={
              e.kind === "final"
                ? "final-answer"
                : e.kind === "director"
                  ? "director-entry"
                  : "transcript-entry"
            }
            className={`border-2 p-2 text-sm ${KIND_STYLE[e.kind]}`}
          >
            <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-indigo-300">
              <span>
                {e.kind === "final"
                  ? "🏆 Final answer"
                  : e.kind === "director"
                    ? `🎙 Director · R${e.round}`
                    : `R${e.round} · ${e.agentId}`}
              </span>
              <span>{e.action}</span>
            </div>
            {e.kind === "status" || e.kind === "error" ? (
              <p className="whitespace-pre-wrap break-words">{e.text}</p>
            ) : (
              <Markdown>{e.text}</Markdown>
            )}
          </li>
        ))}
      </ol>
      {finalAnswer ? <FinalAnswer text={finalAnswer} /> : null}
      <div ref={endRef} />
    </div>
  );
}
