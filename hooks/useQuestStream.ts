"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { initialQuestState, questReducer, type QuestState } from "@/lib/client/questReducer";
import { playSound, unlockAudio } from "@/lib/client/sound";
import { CouncilEventSchema, OrchestrationPlanSchema } from "@/lib/shared";

const RECONNECT_MS = 1500;
const MAX_RECONNECTS = 20;
/** Events arriving this soon after a reconnect are a replay burst: stay silent. */
const REPLAY_QUIET_MS = 400;

export interface UseQuestStream {
  state: QuestState;
  starting: boolean;
  /** Connection or request error (distinct from a quest ERROR event). */
  connectionError: string | null;
  start: (query: string) => Promise<void>;
  /** Attach to an existing quest (replays its events from seq 0). */
  attach: (questId: string) => Promise<void>;
  /** Pause/resume/inject guidance. Resolves true on success. */
  control: (action: "pause" | "resume" | "inject", text?: string) => Promise<boolean>;
  /** Answer the plan-approval gate. */
  approve: (approved: boolean) => Promise<boolean>;
}

export function useQuestStream(): UseQuestStream {
  const [state, dispatch] = useReducer(questReducer, initialQuestState);
  const [starting, setStarting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastIdRef = useRef(0);
  const genRef = useRef(0);
  const quietUntilRef = useRef(0);
  const connectRef = useRef<(questId: string, gen: number, attempt: number) => void>(() => {});

  const close = useCallback(() => {
    genRef.current++;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const connect = useCallback((questId: string, gen: number, attempt: number) => {
    const qs = lastIdRef.current > 0 ? `?lastEventId=${lastIdRef.current}` : "";
    const es = new EventSource(`/api/quests/${encodeURIComponent(questId)}/stream${qs}`);
    sourceRef.current = es;
    // Any (re)open after the first attempt or a browser auto-retry replays history.
    let reopened = attempt > 0;
    es.onopen = () => {
      if (reopened) quietUntilRef.current = Date.now() + REPLAY_QUIET_MS;
      reopened = true;
    };
    es.onmessage = (msg: MessageEvent) => {
      if (gen !== genRef.current) return;
      let json: unknown;
      try {
        json = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      const parsed = CouncilEventSchema.safeParse(json);
      if (!parsed.success) return;
      const isNew = parsed.data.id > lastIdRef.current;
      lastIdRef.current = Math.max(lastIdRef.current, parsed.data.id);
      if (isNew && Date.now() >= quietUntilRef.current) playSound(parsed.data.action);
      dispatch({ type: "event", event: parsed.data });
      if (parsed.data.action === "DONE" || parsed.data.action === "ERROR") {
        es.close();
        sourceRef.current = null;
      }
    };
    es.onerror = () => {
      if (gen !== genRef.current) return;
      // Browser auto-reconnects (resending Last-Event-ID) unless the stream is CLOSED.
      if (es.readyState !== 2) return;
      es.close();
      if (attempt >= MAX_RECONNECTS) {
        setConnectionError("Lost connection to the council");
        return;
      }
      timerRef.current = setTimeout(() => {
        if (gen === genRef.current) connectRef.current(questId, gen, attempt + 1);
      }, RECONNECT_MS);
    };
  }, []);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const start = useCallback(
    async (query: string) => {
      close();
      lastIdRef.current = 0;
      setConnectionError(null);
      setStarting(true);
      try {
        const res = await fetch("/api/quests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const err = (body as { error?: unknown } | null)?.error;
          throw new Error(typeof err === "string" ? err : `Request failed (${res.status})`);
        }
        const questId = (body as { questId?: unknown } | null)?.questId;
        const plan = OrchestrationPlanSchema.safeParse((body as { plan?: unknown } | null)?.plan);
        if (typeof questId !== "string" || !plan.success) throw new Error("Malformed response");
        dispatch({ type: "start", questId, plan: plan.data });
        connect(questId, genRef.current, 0);
      } catch (e) {
        setConnectionError(e instanceof Error ? e.message : "Failed to start quest");
      } finally {
        setStarting(false);
      }
    },
    [close, connect],
  );

  const attach = useCallback(
    async (id: string) => {
      close();
      lastIdRef.current = 0;
      quietUntilRef.current = Date.now() + REPLAY_QUIET_MS;
      setConnectionError(null);
      const gen = genRef.current;
      try {
        const res = await fetch(`/api/quests/${encodeURIComponent(id)}`);
        const body: unknown = await res.json().catch(() => null);
        if (gen !== genRef.current) return;
        if (!res.ok) {
          dispatch({ type: "reset" });
          const err = (body as { error?: unknown } | null)?.error;
          throw new Error(
            res.status === 404 ? "Quest not found" : typeof err === "string" ? err : `Request failed (${res.status})`,
          );
        }
        const info = body as { source?: unknown; status?: unknown } | null;
        dispatch({
          type: "attach",
          questId: id,
          source: typeof info?.source === "string" ? info.source : "web",
        });
        if (info?.status === "interrupted") {
          setConnectionError("Quest was interrupted by a server restart");
        }
        connect(id, gen, 0);
      } catch (e) {
        if (gen === genRef.current) {
          setConnectionError(e instanceof Error ? e.message : "Failed to open quest");
        }
      }
    },
    [close, connect],
  );

  const questId = state.questId;
  const post = useCallback(
    async (path: string, payload: unknown): Promise<boolean> => {
      if (!questId) return false;
      try {
        const res = await fetch(`/api/quests/${encodeURIComponent(questId)}/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => null);
          const err = (body as { error?: unknown } | null)?.error;
          throw new Error(typeof err === "string" ? err : `Request failed (${res.status})`);
        }
        setConnectionError(null);
        return true;
      } catch (e) {
        setConnectionError(e instanceof Error ? e.message : "Request failed");
        return false;
      }
    },
    [questId],
  );
  const control = useCallback(
    (action: "pause" | "resume" | "inject", text?: string) =>
      post("control", action === "inject" ? { action, text } : { action }),
    [post],
  );
  const approve = useCallback((approved: boolean) => post("approve", { approved }), [post]);

  useEffect(() => close, [close]);

  // Browsers only allow audio after a user gesture (iOS Safari especially).
  useEffect(() => {
    const events = ["pointerdown", "keydown", "touchend"] as const;
    const unlock = () => {
      unlockAudio();
      for (const e of events) window.removeEventListener(e, unlock);
    };
    for (const e of events) window.addEventListener(e, unlock);
    return () => {
      for (const e of events) window.removeEventListener(e, unlock);
    };
  }, []);

  return { state, starting, connectionError, start, attach, control, approve };
}
