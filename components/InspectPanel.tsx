"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { AVATAR_GLYPH } from "./mock-data";
import type { AgentState, Citation, TranscriptEntry } from "@/lib/client/questReducer";

/** Hostname of an http(s) URL, or null when the URL is not safe to link. */
export function safeHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch {
    return null;
  }
}

const FOCUSABLE = 'a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-2 border-black bg-black/30 p-2">
      <dt className="text-[10px] uppercase tracking-wider text-indigo-300">{label}</dt>
      <dd className="break-words text-sm font-bold">{value}</dd>
    </div>
  );
}

export function CitationList({ citations }: { citations: Citation[] }) {
  return (
    <ul className="space-y-1" data-testid="citation-list">
      {citations.map((c, i) => {
        const host = safeHost(c.url);
        return (
          <li key={`${c.url}-${i}`} className="text-sm">
            {host ? (
              <a
                href={c.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="block min-h-11 break-words py-1 text-sky-300 underline hover:text-amber-300"
              >
                {c.title || host}
                <span className="block text-[11px] text-indigo-300 no-underline">{host}</span>
              </a>
            ) : (
              <span className="break-words text-indigo-300">{c.title || c.url}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function InspectPanel({
  agent,
  entry,
  onClose,
}: {
  agent: AgentState | undefined;
  entry?: TranscriptEntry;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  const [thoughtOpen, setThoughtOpen] = useState(false);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panelRef.current.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, []);

  const role = agent?.role ?? entry?.agentId ?? "Unknown";
  const glyph = AVATAR_GLYPH[agent?.avatar ?? ""] ?? "❓";
  const model = entry?.model ?? agent?.modelUsed ?? agent?.model;
  const tokens = entry ? entry.tokensUsed : (agent?.tokensUsed ?? 0);
  const cost = entry ? entry.costUsd : agent?.costUsd;
  const latency = entry ? entry.latencyMs : agent?.lastLatencyMs;
  const thought = entry ? entry.thought : agent?.lastThought;
  const citations = (entry ? entry.citations : agent?.lastCitations) ?? [];
  const text = entry?.text ?? agent?.latestLine;

  return (
    <div className="fixed inset-0 z-50" data-testid="inspect-overlay">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close inspector"
        data-testid="inspect-backdrop"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Inspect ${role}`}
        data-testid="inspect-panel"
        className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto overscroll-contain border-t-4 border-amber-200/80 bg-indigo-950 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-sm shadow-[0_-4px_0_0_#000] motion-safe:animate-[inspect-up_150ms_ease-out] sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[26rem] sm:max-w-full sm:border-l-4 sm:border-t-0 sm:pr-[max(0.75rem,env(safe-area-inset-right))] sm:shadow-[-4px_0_0_0_#000] sm:motion-safe:animate-[inspect-in_150ms_ease-out]"
      >
        <div className="mb-3 flex items-center gap-3">
          <span
            aria-hidden
            className="grid size-12 flex-none place-items-center border-2 border-black bg-indigo-900 text-3xl"
          >
            {glyph}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-bold text-amber-300">{role}</h2>
            <p className="text-[11px] uppercase text-indigo-300">
              {entry ? `Round ${entry.round} · ${entry.action}` : (agent?.status ?? "")}
            </p>
          </div>
          <button
            type="button"
            data-autofocus
            onClick={onClose}
            aria-label="Close"
            className="min-h-11 min-w-11 border-2 border-black bg-amber-300 font-bold text-black"
          >
            ✕
          </button>
        </div>

        <dl className="mb-3 grid grid-cols-2 gap-2">
          <Stat label="Model" value={model ?? "—"} />
          <Stat label="Tokens" value={tokens.toLocaleString()} />
          <Stat label="Cost" value={cost === undefined ? "—" : `$${cost.toFixed(4)}`} />
          <Stat label="Latency" value={latency === undefined ? "—" : `${latency} ms`} />
        </dl>
        {agent?.fallback && (
          <p className="mb-3 text-xs text-fuchsia-300" data-testid="inspect-fallback">
            Fallback: {agent.fallback.primary || "primary"} → {agent.fallback.modelUsed || "backup"}
          </p>
        )}

        {text && (
          <div className="mb-3 border-2 border-black bg-black/40 p-2">
            <Markdown>{text}</Markdown>
          </div>
        )}

        <section className="mb-3">
          <button
            type="button"
            aria-expanded={thoughtOpen}
            aria-controls="inspect-thought"
            disabled={!thought}
            onClick={() => setThoughtOpen((o) => !o)}
            className="min-h-11 w-full border-2 border-black bg-indigo-900 px-2 text-left text-xs font-bold uppercase tracking-wider disabled:opacity-50"
          >
            {thoughtOpen ? "▾" : "▸"} Thought log{thought ? "" : " (none)"}
          </button>
          {thought && thoughtOpen && (
            <div id="inspect-thought" className="border-2 border-t-0 border-black p-2">
              <Markdown>{thought}</Markdown>
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-amber-300">
            Citations
          </h3>
          {citations.length ? (
            <CitationList citations={citations} />
          ) : (
            <p className="text-xs text-indigo-300">No citations.</p>
          )}
        </section>
      </div>
    </div>
  );
}
