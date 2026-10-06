"use client";

import { useState } from "react";

const BTN =
  "min-h-11 min-w-11 flex-1 border-2 border-black bg-amber-300 px-3 text-xs font-bold uppercase text-black shadow-[2px_2px_0_0_#000] disabled:cursor-not-allowed disabled:opacity-50";

export function ActionBar({
  onSubmit,
  busy = false,
  error = null,
  running = false,
  paused = false,
  onControl,
}: {
  onSubmit?: (query: string) => void;
  /** True while a quest is starting or running. */
  busy?: boolean;
  error?: string | null;
  /** True only while a quest is actively running (enables HITL controls). */
  running?: boolean;
  paused?: boolean;
  onControl?: (action: "pause" | "resume" | "inject", text?: string) => Promise<boolean> | void;
}) {
  const [query, setQuery] = useState("");
  const [guidance, setGuidance] = useState("");
  const canControl = running && !!onControl;
  const canInject = canControl && guidance.trim().length > 0;
  const canSubmit = !busy && query.trim().length > 0 && !!onSubmit;
  return (
    <div className="flex-none space-y-2 border-t-4 border-amber-200/80 bg-indigo-950 px-3 pt-2 pb-2 lg:pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <form
        aria-label="Quest actions"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          onSubmit?.(query.trim());
          setQuery("");
        }}
        className="space-y-2"
      >
        {error && (
          <p role="alert" className="text-xs text-red-300">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            aria-label="Quest"
            placeholder="Enter your quest…"
            enterKeyHint="send"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={busy}
            maxLength={4000}
            className="min-h-11 min-w-0 flex-1 border-2 border-black bg-black/50 px-3 text-base text-white placeholder:text-indigo-300"
          />
          <button type="submit" disabled={!canSubmit} className={`${BTN} flex-none`}>
            Go
          </button>
        </div>
      </form>
      <form
        aria-label="Director controls"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canInject) return;
          const text = guidance.trim();
          setGuidance("");
          void onControl?.("inject", text);
        }}
        className="flex gap-2"
      >
        <button
          type="button"
          disabled={!canControl}
          aria-pressed={paused}
          onClick={() => void onControl?.(paused ? "resume" : "pause")}
          className={`${BTN} flex-none`}
        >
          {paused ? "Resume" : "Pause Deliberation"}
        </button>
        <input
          type="text"
          aria-label="Director guidance"
          placeholder="Director guidance…"
          enterKeyHint="send"
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          disabled={!canControl}
          maxLength={2000}
          className="min-h-11 min-w-0 flex-1 border-2 border-black bg-black/50 px-3 text-base text-white placeholder:text-indigo-300 disabled:opacity-50"
        />
        <button type="submit" disabled={!canInject} className={`${BTN} flex-none`}>
          Send
        </button>
      </form>
    </div>
  );
}
