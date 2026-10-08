"use client";

import { useEffect, useRef } from "react";
import { Markdown } from "./Markdown";
import { ExportControl } from "./ExportControl";
import { FinalAnswer } from "./FinalAnswer";
import { safeHost } from "./InspectPanel";
import { AttachmentList } from "./Attachments";
import type { AttachmentRef, InspectSelection, TranscriptEntry } from "@/lib/client/questReducer";

const KIND_STYLE: Record<TranscriptEntry["kind"], string> = {
  message: "border-amber-200/60 bg-indigo-950/80",
  status: "border-indigo-400/40 bg-indigo-950/50 italic text-indigo-200",
  final: "border-amber-300 bg-amber-300/20 shadow-[3px_3px_0_0_#000]",
  director: "border-sky-300 bg-sky-950/70 text-sky-50",
  error: "border-red-500 bg-red-950/60 text-red-100",
  quest: "border-emerald-300/70 bg-emerald-950/50 text-emerald-50",
  digest: "border-violet-300/70 bg-violet-950/60 text-violet-50",
  memory: "border-pink-300/70 bg-pink-950/50 text-pink-50",
};

export function TranscriptPanel({
  entries,
  finalAnswer,
  questId,
  onInspect,
  onOpenAttachment,
}: {
  entries: TranscriptEntry[];
  finalAnswer?: string | null;
  questId?: string | null;
  onInspect?: (sel: InspectSelection) => void;
  onOpenAttachment?: (a: AttachmentRef) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [entries.length, finalAnswer]);
  const visible = finalAnswer ? entries.filter((e) => e.kind !== "final") : entries;
  return (
    <div className="h-full overflow-y-auto overscroll-contain p-3" data-testid="transcript-scroll">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-widest text-amber-300">
          Discussion Stream
        </h2>
        <ExportControl questId={questId ?? null} />
      </div>
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
                  : e.kind === "quest"
                    ? "quest-entry"
                    : e.kind === "digest"
                      ? "digest-entry"
                      : e.kind === "memory"
                        ? "memory-entry"
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
                    : e.kind === "quest"
                      ? "🗡 Your quest"
                      : e.kind === "digest"
                        ? "📎 Attachment digest"
                        : e.kind === "memory"
                          ? "🧠 Memory"
                        : `R${e.round} · ${e.agentId}`}
              </span>
              <span>{e.action}</span>
            </div>
            {e.kind === "quest" ? (
              <>
                <p className="whitespace-pre-wrap break-words">{e.text}</p>
                <AttachmentList attachments={e.attachments ?? []} onOpen={onOpenAttachment} />
              </>
            ) : e.kind === "memory" ? (
              <>
                <p className="whitespace-pre-wrap break-words">{e.text}</p>
                {e.block && (
                  <details className="mt-1" data-testid="memory-details">
                    <summary className="min-h-8 cursor-pointer text-[10px] uppercase text-pink-200 underline">
                      Show injected block
                    </summary>
                    <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words border border-black bg-black/40 p-2 text-[11px]">
                      {e.block}
                    </pre>
                  </details>
                )}
              </>
            ) : e.kind === "status" || e.kind === "error" ? (
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
