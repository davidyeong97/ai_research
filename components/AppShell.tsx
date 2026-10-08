"use client";

import { useEffect, useState } from "react";
import { StatsBar } from "./StatsBar";
import { ActionBar } from "./ActionBar";
import { ApprovalDialog } from "./ApprovalDialog";
import { ArenaPanel } from "./ArenaPanel";
import { TranscriptPanel } from "./TranscriptPanel";
import type { AttachmentRef, InspectSelection } from "@/lib/client/questReducer";
import { ImageLightbox } from "./Attachments";
import { MemoryPanel } from "./MemoryPanel";
import { InspectPanel } from "./InspectPanel";
import { RecentQuests } from "./RecentQuests";
import { useQuestStream } from "@/hooks/useQuestStream";

type Tab = "arena" | "stream";
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "arena", label: "Visual Arena", icon: "⚔️" },
  { id: "stream", label: "Discussion Stream", icon: "📜" },
];

export function AppShell() {
  const [lightbox, setLightbox] = useState<AttachmentRef | null>(null);
  const [selected, setSelected] = useState<InspectSelection | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("arena");
  const { state, starting, uploading, connectionError, start, attach, control, approve } = useQuestStream();
  const [recentOpen, setRecentOpen] = useState(false);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("quest");
    if (id) void attach(id);
  }, [attach]);

  const openQuest = (id: string) => {
    window.history.pushState(null, "", `/?quest=${encodeURIComponent(id)}`);
    void attach(id);
  };
  const [unread, setUnread] = useState(false);
  const [prev, setPrev] = useState({ count: 0, verdict: false });
  const count = state.transcript.length;
  const verdict = state.phase === "done" && !!state.finalAnswer;
  if (prev.count !== count || prev.verdict !== verdict) {
    setPrev({ count, verdict });
    if (verdict && !prev.verdict) {
      setTab("stream");
      setUnread(false);
    } else if (count > prev.count && prev.count > 0 && tab === "arena") {
      setUnread(true);
    }
  }
  const selectTab = (t: Tab) => {
    setTab(t);
    if (t === "stream") setUnread(false);
  };
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-indigo-950 pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] font-mono text-indigo-50">
      <header className="relative flex-none border-b-4 border-amber-200/80 px-3 py-2 text-center text-lg font-bold tracking-widest text-amber-300">
        ⚔ COUNCIL ⚔
        <button
          type="button"
          onClick={() => setRecentOpen(true)}
          aria-label="Recent quests"
          className="absolute left-2 top-1 min-h-11 min-w-11 border-2 border-black bg-amber-300 text-base text-black"
        >
          📜
        </button>
        <button
          type="button"
          data-testid="memory-button"
          aria-label="Open memory manager"
          onClick={() => setManagerOpen(true)}
          className="absolute right-2 top-1/2 min-h-11 min-w-11 -translate-y-1/2 border-2 border-black bg-pink-300 px-2 text-xs tracking-normal text-black"
        >
          🧠 Memory
        </button>
      </header>
      <RecentQuests open={recentOpen} onClose={() => setRecentOpen(false)} onSelect={openQuest} />
      <StatsBar state={state} onOpenMemory={() => setMemoryOpen(true)} />
      <main className="flex min-h-0 flex-1 lg:grid lg:grid-cols-2 lg:divide-x-4 lg:divide-amber-200/80">
        <section
          id="panel-arena"
          role="tabpanel"
          aria-label="Visual Arena"
          className={`min-h-0 flex-1 ${tab === "arena" ? "block" : "hidden"} lg:block`}
        >
          <ArenaPanel agents={state.agents} paused={state.paused} onInspect={setSelected} />
        </section>
        <section
          id="panel-stream"
          role="tabpanel"
          aria-label="Discussion Stream"
          className={`min-h-0 flex-1 ${tab === "stream" ? "block" : "hidden"} lg:block`}
        >
          <TranscriptPanel
            entries={state.transcript}
            finalAnswer={state.phase === "done" ? state.finalAnswer : null}
            questId={state.questId}
            onInspect={setSelected}
            onOpenAttachment={setLightbox}
          />
        </section>
      </main>
      <ActionBar
        onSubmit={start}
        busy={starting || state.phase === "running"}
        uploading={uploading}
        error={connectionError}
        running={state.phase === "running" && !state.pendingApproval}
        paused={state.paused}
        onControl={control}
      />
      {managerOpen && (
        <MemoryPanel questId={state.questId} onClose={() => setManagerOpen(false)} />
      )}
      {!selected && memoryOpen && (
        <InspectPanel
          agent={undefined}
          memories={state.recalled}
          initialTab="memory"
          onClose={() => setMemoryOpen(false)}
        />
      )}
      {selected && (
        <InspectPanel
          memories={state.recalled}
          agent={state.agents.find((a) => a.id === selected.agentId)}
          entry={
            selected.entryId === undefined
              ? undefined
              : state.transcript.find((t) => t.id === selected.entryId)
          }
          onClose={() => setSelected(null)}
        />
      )}
      {lightbox && <ImageLightbox attachment={lightbox} onClose={() => setLightbox(null)} />}
      {state.pendingApproval && (
        <ApprovalDialog approval={state.pendingApproval} onDecide={approve} />
      )}
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
            onClick={() => selectTab(t.id)}
            className={`flex relative min-h-12 flex-1 flex-col items-center justify-center text-[11px] font-bold uppercase ${
              tab === t.id ? "bg-amber-300 text-black" : "text-indigo-200"
            }`}
          >
            <span aria-hidden>{t.icon}</span>
            {t.label}
            {t.id === "stream" && unread && tab !== "stream" && (
              <span
                data-testid="unread-dot"
                aria-label="New messages"
                className="absolute right-[18%] top-1.5 h-2.5 w-2.5 rounded-full bg-red-500"
              />
            )}
          </button>
        ))}
      </nav>
      <div className="hidden pb-[env(safe-area-inset-bottom)] lg:block" />
    </div>
  );
}
