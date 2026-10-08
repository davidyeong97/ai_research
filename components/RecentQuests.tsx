"use client";

import { useEffect, useState } from "react";
import { AgentBadge } from "./AgentBadge";

export interface RecentQuest {
  questId: string;
  query: string;
  status: string;
  source: string;
  totalCostUsd: number;
  createdAt: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (questId: string) => void;
}

export function RecentQuests({ open, onClose, onSelect }: Props) {
  const [quests, setQuests] = useState<RecentQuest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/quests?limit=20")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        return (await res.json()) as { quests?: RecentQuest[] };
      })
      .then((body) => {
        if (cancelled) return;
        setError(null);
        setQuests(body.quests ?? []);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load quests");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label="Recent quests"
      className="fixed inset-0 z-40 flex flex-col bg-indigo-950/95 pt-[env(safe-area-inset-top)] font-mono text-indigo-50"
    >
      <div className="flex items-center justify-between border-b-4 border-amber-200/80 px-3 py-2">
        <h2 className="text-sm font-bold uppercase tracking-widest text-amber-300">Recent quests</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close recent quests"
          className="min-h-11 min-w-11 border-2 border-black bg-amber-300 font-bold text-black"
        >
          ✕
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {error && <li role="alert" className="p-2 text-red-400">{error}</li>}
        {!error && quests === null && <li className="p-2 text-indigo-300">Loading…</li>}
        {quests?.length === 0 && <li className="p-2 text-indigo-300">No quests yet.</li>}
        {quests?.map((q) => (
          <li key={q.questId} className="mb-2">
            <button
              type="button"
              data-testid="recent-item"
              onClick={() => {
                onSelect(q.questId);
                onClose();
              }}
              className="flex min-h-11 w-full flex-col gap-1 border-2 border-amber-200/60 bg-indigo-900 p-2 text-left"
            >
              <span className="line-clamp-2 text-sm font-bold">{q.query}</span>
              <span className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="border border-black bg-amber-300 px-1.5 py-0.5 uppercase text-black">
                  {q.status.replace(/_/g, " ")}
                </span>
                <span>${q.totalCostUsd.toFixed(3)}</span>
                <AgentBadge source={q.source} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
