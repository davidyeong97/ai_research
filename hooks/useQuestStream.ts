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
  /** True while attachments are being uploaded. */
  uploading: boolean;
  /** Upload files (if any) then start the quest. Resolves true on success. */
  start: (query: string, files?: File[]) => Promise<boolean>;
  /** Attach to an existing quest (replays its events from seq 0). */
  attach: (questId: string) => Promise<void>;
  /** Pause/resume/inject guidance. Resolves true on success. */
  control: (action: "pause" | "resume" | "inject", text?: string) => Promise<boolean>;
  /** Answer the plan-approval gate. */
  approve: (approved: boolean) => Promise<boolean>;
}

function errorText(body: unknown, status: number): string {
  const err = (body as { error?: unknown } | null)?.error;
  return typeof err === "string" ? err : `Request failed (${status})`;
}

export function useQuestStream(): UseQuestStream {
  const [state, dispatch] = useReducer(questReducer, initialQuestState);
  const [starting, setStarting] = useState(false);
  const [uploading, setUploading] = useState(false);
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
    async (query: string, files: File[] = []): Promise<boolean> => {
      close();
      lastIdRef.current = 0;
      setConnectionError(null);
      setStarting(true);
      try {
        let attachmentIds: string[] | undefined;
        if (files.length > 0) {
          setUploading(true);
          try {
            const form = new FormData();
            for (const f of files) form.append("files", f);
            const up = await fetch("/api/uploads", { method: "POST", body: form });
            const upBody: unknown = await up.json().catch(() => null);
            if (!up.ok) throw new Error(errorText(upBody, up.status));
            const list = (upBody as { attachments?: unknown } | null)?.attachments;
            attachmentIds = Array.isArray(list)
              ? list.flatMap((a) => {
                  const id = (a as { id?: unknown } | null)?.id;
                  return typeof id === "string" ? [id] : [];
                })
              : [];
            if (attachmentIds.length !== files.length) throw new Error("Upload failed");
          } finally {
            setUploading(false);
          }
        }
        const res = await fetch("/api/quests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(attachmentIds ? { query, attachmentIds } : { query }),
        });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) throw new Error(errorText(body, res.status));
        const questId = (body as { questId?: unknown } | null)?.questId;
        const plan = OrchestrationPlanSchema.safeParse((body as { plan?: unknown } | null)?.plan);
        if (typeof questId !== "string" || !plan.success) throw new Error("Malformed response");
        dispatch({ type: "start", questId, plan: plan.data });
        connect(questId, genRef.current, 0);
        return true;
      } catch (e) {
        setConnectionError(e instanceof Error ? e.message : "Failed to start quest");
        return false;
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

  return { state, starting, uploading, connectionError, start, attach, control, approve };
}
