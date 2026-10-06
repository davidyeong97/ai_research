"use client";

import { useState } from "react";
import { ActionBar } from "./ActionBar";
import { ArenaPanel } from "./ArenaPanel";
import { TranscriptPanel } from "./TranscriptPanel";
import { MOCK_AGENTS, MOCK_EVENTS } from "./mock-data";
import type { CouncilEvent } from "@/lib/shared";
import type { MockAgent } from "./mock-data";

type Tab = "arena" | "stream";
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "arena", label: "Visual Arena", icon: "⚔️" },
  { id: "stream", label: "Discussion Stream", icon: "📜" },
];

export function AppShell({
  agents = MOCK_AGENTS,
  events = MOCK_EVENTS,
}: {
  agents?: MockAgent[];
  events?: CouncilEvent[];
}) {
  const [tab, setTab] = useState<Tab>("arena");
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-indigo-950 pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] font-mono text-indigo-50">
      <header className="flex-none border-b-4 border-amber-200/80 px-3 py-2 text-center text-lg font-bold tracking-widest text-amber-300">
        ⚔ COUNCIL ⚔
      </header>
      <main className="flex min-h-0 flex-1 lg:grid lg:grid-cols-2 lg:divide-x-4 lg:divide-amber-200/80">
        <section
          id="panel-arena"
          role="tabpanel"
          aria-label="Visual Arena"
          className={`min-h-0 flex-1 ${tab === "arena" ? "block" : "hidden"} lg:block`}
        >
          <ArenaPanel agents={agents} />
        </section>
        <section
          id="panel-stream"
          role="tabpanel"
          aria-label="Discussion Stream"
          className={`min-h-0 flex-1 ${tab === "stream" ? "block" : "hidden"} lg:block`}
        >
          <TranscriptPanel events={events} />
        </section>
      </main>
      <ActionBar />
      <nav
        role="tablist"
        aria-label="Views"
        className="flex flex-none border-t-4 border-amber-200/80 bg-indigo-900 pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`flex min-h-12 flex-1 flex-col items-center justify-center text-[11px] font-bold uppercase ${
              tab === t.id ? "bg-amber-300 text-black" : "text-indigo-200"
            }`}
          >
            <span aria-hidden>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="hidden pb-[env(safe-area-inset-bottom)] lg:block" />
    </div>
  );
}
