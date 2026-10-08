"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type MemoryKind = "fact" | "preference" | "summary";
export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  content: string;
  sourceQuestId: string | null;
  pinned: boolean;
  confidence: number;
}

const KIND_STYLE: Record<MemoryKind, string> = {
  fact: "border-sky-300/60 bg-sky-950/60 text-sky-200",
  preference: "border-pink-300/60 bg-pink-950/60 text-pink-200",
  summary: "border-emerald-300/60 bg-emerald-950/60 text-emerald-200",
};
const KINDS: Array<MemoryKind | ""> = ["", "fact", "preference", "summary"];
const BTN = "min-h-11 min-w-11 border-2 border-black px-2 text-xs font-bold";

export function MemoryPanel({
  questId,
  onClose,
}: {
  questId?: string | null;
  onClose: () => void;
}) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<MemoryKind | "">("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const load = useCallback(async (query: string, k: MemoryKind | "", signal?: AbortSignal) => {
    const sp = new URLSearchParams({ limit: "200" });
    if (query.trim()) sp.set("q", query.trim());
    if (k) sp.set("kind", k);
    try {
      const res = await fetch(`/api/memories?${sp}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { enabled: boolean; memories: MemoryItem[] };
      setItems(data.memories);
      setEnabled(data.enabled);
      setError(null);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError("Could not load memories.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => void load(q, kind, ac.signal), q ? 250 : 0);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q, kind, load]);

  const call = async (url: string, method: string, body?: unknown): Promise<Response | null> => {
    try {
      const res = await fetch(url, {
        method,
        ...(body !== undefined
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `Request failed (${res.status})`);
        return null;
      }
      setError(null);
      return res;
    } catch {
      setError("Network error.");
      return null;
    }
  };

  const togglePin = async (m: MemoryItem) => {
    const res = await call(`/api/memories/${m.id}`, "PATCH", { pinned: !m.pinned });
    if (!res) return;
    const { memory } = (await res.json()) as { memory: MemoryItem };
    setItems((cur) => cur.map((x) => (x.id === m.id ? memory : x)));
  };
  const saveEdit = async () => {
    if (!editing || !editing.text.trim()) return;
    const res = await call(`/api/memories/${editing.id}`, "PATCH", { content: editing.text });
    if (!res) return;
    const { memory } = (await res.json()) as { memory: MemoryItem };
    setItems((cur) => cur.map((x) => (x.id === memory.id ? memory : x)));
    setEditing(null);
  };
  const remove = async (m: MemoryItem) => {
    if (!(await call(`/api/memories/${m.id}`, "DELETE"))) return;
    setItems((cur) => cur.filter((x) => x.id !== m.id));
  };
  const add = async () => {
    if (!adding?.trim()) return;
    if (!(await call("/api/memories", "POST", { content: adding }))) return;
    setAdding(null);
    setNotice("Memory saved.");
    await load(q, kind);
  };
  const forgetQuest = async () => {
    if (!questId) return;
    const res = await call(`/api/memories?sourceQuest=${encodeURIComponent(questId)}`, "DELETE");
    if (!res) return;
    const { deleted } = (await res.json()) as { deleted: number };
    setNotice(`Forgot ${deleted} memor${deleted === 1 ? "y" : "ies"} from this quest.`);
    await load(q, kind);
  };

  return (
    <div className="fixed inset-0 z-50" data-testid="memory-overlay">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close memory panel"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Memory"
        data-testid="memory-panel"
        className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col border-t-4 border-amber-200/80 bg-indigo-950 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-sm shadow-[0_-4px_0_0_#000] sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[26rem] sm:max-w-full sm:border-l-4 sm:border-t-0 sm:shadow-[-4px_0_0_0_#000]"
      >
        <div className="mb-2 flex items-center gap-2">
          <h2 className="flex-1 font-bold text-amber-300">🧠 Memory</h2>
          <button type="button" onClick={onClose} aria-label="Close" className={`${BTN} bg-amber-300 text-black`}>
            ✕
          </button>
        </div>

        {!enabled && (
          <p data-testid="memory-disabled" className="mb-2 border-2 border-black bg-amber-950/60 p-2 text-xs text-amber-200">
            Memory is turned off (MEMORY_ENABLED=false). Nothing new is saved or recalled, but you
            can still review and delete what is stored.
          </p>
        )}

        <input
          type="search"
          aria-label="Search memories"
          placeholder="Search memories…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="mb-2 min-h-11 w-full border-2 border-black bg-black/40 px-2 text-indigo-50"
        />
        <div className="mb-2 flex gap-1" role="group" aria-label="Filter by kind">
          {KINDS.map((k) => (
            <button
              key={k || "all"}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={`${BTN} flex-1 uppercase ${kind === k ? "bg-amber-300 text-black" : "bg-indigo-900"}`}
            >
              {k || "all"}
            </button>
          ))}
        </div>

        <div className="mb-2 flex gap-1">
          {enabled && (
            <button type="button" onClick={() => setAdding(adding === null ? "" : null)} className={`${BTN} flex-1 bg-emerald-300 text-black`}>
              ＋ Add memory
            </button>
          )}
          {questId && (
            <button type="button" onClick={forgetQuest} className={`${BTN} flex-1 bg-red-300 text-black`}>
              Forget quest memory
            </button>
          )}
        </div>
        {adding !== null && (
          <div className="mb-2 flex gap-1">
            <input
              aria-label="New memory"
              placeholder="e.g. I prefer concise answers"
              maxLength={1000}
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              className="min-h-11 min-w-0 flex-1 border-2 border-black bg-black/40 px-2"
            />
            <button type="button" onClick={add} className={`${BTN} bg-amber-300 text-black`}>
              Save
            </button>
          </div>
        )}
        {notice && (
          <p role="status" className="mb-2 text-xs text-emerald-300">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="mb-2 text-xs text-red-300">
            {error}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {loading ? (
            <p className="text-xs text-indigo-300">Loading…</p>
          ) : items.length === 0 ? (
            <p data-testid="memory-empty" className="text-xs text-indigo-300">
              {q || kind
                ? "No memories match."
                : "No memories yet. Council saves durable facts and preferences after a quest finishes, or you can add one yourself."}
            </p>
          ) : (
            <ul className="space-y-2" data-testid="memory-items">
              {items.map((m) => (
                <li key={m.id} data-testid="memory-item" className="border-2 border-black bg-black/30 p-2">
                  <div className="mb-1 flex items-center gap-2 text-[10px] uppercase">
                    <span className={`border px-1.5 ${KIND_STYLE[m.kind]}`}>{m.kind}</span>
                    <span className="text-indigo-300">{Math.round(m.confidence * 100)}%</span>
                    {m.sourceQuestId && <span className="truncate text-indigo-400">quest {m.sourceQuestId.slice(0, 8)}</span>}
                  </div>
                  {editing?.id === m.id ? (
                    <div className="flex flex-col gap-1">
                      <textarea
                        aria-label="Edit memory"
                        rows={3}
                        maxLength={1000}
                        value={editing.text}
                        onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                        className="w-full border-2 border-black bg-black/40 p-2"
                      />
                      <div className="flex gap-1">
                        <button type="button" onClick={saveEdit} className={`${BTN} flex-1 bg-amber-300 text-black`}>
                          Save
                        </button>
                        <button type="button" onClick={() => setEditing(null)} className={`${BTN} flex-1 bg-indigo-900`}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="mb-1 whitespace-pre-wrap break-words">{m.content}</p>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          aria-pressed={m.pinned}
                          aria-label={m.pinned ? "Unpin memory" : "Pin memory"}
                          onClick={() => togglePin(m)}
                          className={`${BTN} ${m.pinned ? "bg-amber-300 text-black" : "bg-indigo-900"}`}
                        >
                          📌
                        </button>
                        <button type="button" aria-label="Edit memory text" onClick={() => setEditing({ id: m.id, text: m.content })} className={`${BTN} bg-indigo-900`}>
                          ✏️
                        </button>
                        <button type="button" aria-label="Delete memory" onClick={() => remove(m)} className={`${BTN} bg-red-300 text-black`}>
                          🗑
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
