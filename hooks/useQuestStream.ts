"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { initialQuestState, questReducer, type QuestState } from "@/lib/client/questReducer";
import { CouncilEventSchema, OrchestrationPlanSchema } from "@/lib/shared";

const RECONNECT_MS = 1500;
const MAX_RECONNECTS = 20;

export interface UseQuestStream {
  state: QuestState;
  starting: boolean;
  /** Connection or request error (distinct from a quest ERROR event). */
  connectionError: string | null;
  start: (query: string) => Promise<void>;
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
      lastIdRef.current = Math.max(lastIdRef.current, parsed.data.id);
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

  return { state, starting, connectionError, start, control, approve };
}
