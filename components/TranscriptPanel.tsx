"use client";

import { useEffect, useRef } from "react";
import { Markdown } from "./Markdown";
import { FinalAnswer } from "./FinalAnswer";
import { safeHost } from "./InspectPanel";
import type { InspectSelection, TranscriptEntry } from "@/lib/client/questReducer";

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
  onInspect,
}: {
  entries: TranscriptEntry[];
  finalAnswer?: string | null;
  onInspect?: (sel: InspectSelection) => void;
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
            onClick={
              e.kind === "message" && onInspect
                ? (ev) => {
                    if ((ev.target as HTMLElement).closest("a,button")) return;
                    onInspect({ agentId: e.agentId, entryId: e.id });
                  }
                : undefined
            }
            className={`border-2 p-2 text-sm ${KIND_STYLE[e.kind]} ${e.kind === "message" && onInspect ? "cursor-pointer" : ""}`}
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
            {e.kind === "message" && (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {(e.citations ?? []).slice(0, 3).map((c, i) => {
                  const host = safeHost(c.url);
                  return host ? (
                    <a
                      key={`${c.url}-${i}`}
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      data-testid="citation-chip"
                      className="max-w-[10rem] truncate border border-sky-300/60 bg-sky-950/60 px-1.5 py-0.5 text-[10px] text-sky-200 hover:text-amber-300"
                    >
                      {c.title || host}
                    </a>
                  ) : null;
                })}
                {(e.citations?.length ?? 0) > 3 && (
                  <button
                    type="button"
                    data-testid="citation-more"
                    onClick={() => onInspect?.({ agentId: e.agentId, entryId: e.id })}
                    className="border border-amber-300/60 px-1.5 py-0.5 text-[10px] text-amber-200"
                  >
                    +{(e.citations?.length ?? 0) - 3} more
                  </button>
                )}
                {onInspect && (
                  <button
                    type="button"
                    data-testid="inspect-message"
                    onClick={() => onInspect({ agentId: e.agentId, entryId: e.id })}
                    className="ml-auto min-h-8 px-2 text-[10px] uppercase text-amber-300 underline"
                  >
                    Inspect
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      {finalAnswer ? <FinalAnswer text={finalAnswer} /> : null}
      <div ref={endRef} />
    </div>
  );
}
