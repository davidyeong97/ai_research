import { and, asc, eq, gt, max } from "drizzle-orm";
import { getDb, schema, type DB } from "../db";
import type { CouncilEvent } from "../shared";

export type NewCouncilEvent = Omit<CouncilEvent, "id" | "timestamp"> & { timestamp?: string };
export type Listener = (event: CouncilEvent) => void;

export class EventBus {
  private listeners = new Map<string, Set<Listener>>();
  private seqs = new Map<string, number>();

  constructor(private readonly db: DB) {}

  private nextSeq(questId: string): number {
    let cur = this.seqs.get(questId);
    if (cur === undefined) {
      const row = this.db
        .select({ m: max(schema.events.seq) })
        .from(schema.events)
        .where(eq(schema.events.questId, questId))
        .get();
      cur = row?.m ?? 0;
    }
    const next = cur + 1;
    this.seqs.set(questId, next);
    return next;
  }

  /** Assign seq, persist, then fan out to live subscribers. */
  publish(input: NewCouncilEvent): CouncilEvent {
    const seq = this.nextSeq(input.questId);
    const event: CouncilEvent = {
      ...input,
      id: seq,
      timestamp: input.timestamp ?? new Date().toISOString(),
    };
    this.db.insert(schema.events).values({ questId: event.questId, seq, payload: event }).run();
    for (const l of [...(this.listeners.get(event.questId) ?? [])]) {
      try {
        l(event);
      } catch {
        /* a bad subscriber must not break others */
      }
    }
    return event;
  }

  /** Events with seq > afterSeq, in order. */
  replay(questId: string, afterSeq = 0): CouncilEvent[] {
    return this.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.questId, questId), gt(schema.events.seq, afterSeq)))
      .orderBy(asc(schema.events.seq))
      .all()
      .map((r) => r.payload as CouncilEvent);
  }

  /**
   * Replay missed events, then stream live ones. Replay and registration happen
   * synchronously so no event is lost or duplicated. Returns an unsubscribe fn.
   */
  subscribe(questId: string, afterSeq: number, listener: Listener): () => void {
    let last = afterSeq;
    for (const e of this.replay(questId, afterSeq)) {
      last = e.id;
      listener(e);
    }
    const wrapped: Listener = (e) => {
      if (e.id <= last) return;
      last = e.id;
      listener(e);
    };
    let set = this.listeners.get(questId);
    if (!set) this.listeners.set(questId, (set = new Set()));
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
      if (set.size === 0) this.listeners.delete(questId);
    };
  }
}

const g = globalThis as unknown as { __councilBus?: EventBus };

/** Singleton on globalThis so it survives dev hot reload. */
export function getBus(): EventBus {
  return (g.__councilBus ??= new EventBus(getDb()));
}
