import { describe, expect, it } from "vitest";
import { initialQuestState, questReducer, type QuestState } from "./questReducer";
import { MOCK_PLAN } from "@/components/mock-data";
import type { CouncilEvent } from "@/lib/shared";

let seq = 0;
const ev = (p: Partial<CouncilEvent> & Pick<CouncilEvent, "agentId" | "action">): CouncilEvent => ({
  id: ++seq,
  questId: "q1",
  timestamp: "2026-10-06T10:00:00.000Z",
  round: 1,
  tokensUsed: 0,
  data: {},
  ...p,
});
const run = (s: QuestState, ...events: CouncilEvent[]) =>
  events.reduce((acc, event) => questReducer(acc, { type: "event", event }), s);
const started = () => {
  seq = 0;
  return questReducer(initialQuestState, { type: "start", questId: "q1", plan: MOCK_PLAN });
};

describe("questReducer", () => {
  it("start builds agents from the plan", () => {
    const s = started();
    expect(s.phase).toBe("running");
    expect(s.agents.map((a) => a.id)).toEqual(["claude", "gemini", "grok"]);
    expect(s.agents[0]).toMatchObject({ status: "IDLE", remainingRatio: 1, tokensUsed: 0 });
  });

  it("maps THINKING / SEARCHING to status badges", () => {
    const s = run(
      started(),
      ev({ agentId: "claude", action: "THINKING" }),
      ev({ agentId: "gemini", action: "SEARCHING", data: { statusMessage: "Searching the web…" } }),
    );
    expect(s.agents[0].status).toBe("THINKING");
    expect(s.agents[1].status).toBe("SEARCHING");
    expect(s.agents[1].latestLine).toBe("Searching the web…");
  });

  it("SPEAKING updates bubble, tokens, budget, model, transcript", () => {
    const s = run(
      started(),
      ev({
        agentId: "claude",
        action: "SPEAKING",
        tokensUsed: 100,
        data: {
          message: "Hello",
          costUsd: 0.01,
          model: "m/x",
          budget: { used: 100, remaining: 900, remainingRatio: 0.9 },
        },
      }),
      ev({ agentId: "claude", action: "SPEAKING", tokensUsed: 50, data: { message: "Again" } }),
    );
    expect(s.agents[0]).toMatchObject({
      status: "SPEAKING",
      latestLine: "Again",
      tokensUsed: 150,
      remainingRatio: 0.9,
      modelUsed: "m/x",
    });
    expect(s.agents[0].costUsd).toBeCloseTo(0.01);
    expect(s.transcript.map((t) => t.text)).toEqual(["Hello", "Again"]);
  });

  it("SPEAKING parses thought, citations, model, cost, latency defensively", () => {
    const s = run(
      started(),
      ev({
        agentId: "claude",
        action: "SPEAKING",
        data: {
          message: "Hi",
          thought: "because",
          citations: [{ url: "https://a.com/x", title: "A" }, { url: 5 }, "bad", { url: "https://b.org" }],
          model: "m/x",
          costUsd: 0.002,
          latencyMs: 1200,
        },
      }),
      ev({
        agentId: "claude",
        action: "SPEAKING",
        data: { message: "Bad", thought: 3, citations: "nope", latencyMs: "x" },
      }),
    );
    expect(s.transcript[0]).toMatchObject({
      thought: "because",
      model: "m/x",
      costUsd: 0.002,
      latencyMs: 1200,
      citations: [{ url: "https://a.com/x", title: "A" }, { url: "https://b.org" }],
    });
    expect(s.transcript[1].thought).toBeUndefined();
    expect(s.transcript[1].citations).toBeUndefined();
    expect(s.agents[0].lastThought).toBe("because");
    expect(s.agents[0].lastCitations).toHaveLength(2);
  });

  it("FALLBACK records model info", () => {
    const s = run(
      started(),
      ev({ agentId: "grok", action: "FALLBACK", data: { primary: "a/b", modelUsed: "c/d" } }),
    );
    expect(s.agents[2].status).toBe("FALLBACK");
    expect(s.agents[2].fallback).toEqual({ primary: "a/b", modelUsed: "c/d" });
  });

  it("ignores duplicate / replayed events and other quests", () => {
    const e = ev({ agentId: "claude", action: "SPEAKING", data: { message: "x" } });
    const s = run(started(), e, e, {
      ...ev({ agentId: "claude", action: "THINKING" }),
      questId: "other",
    });
    expect(s.transcript).toHaveLength(1);
    expect(s.lastEventId).toBe(e.id);
  });

  it("adds lead agent dynamically and DONE yields a single highlighted final entry", () => {
    const s = run(
      started(),
      ev({ agentId: "lead", action: "CONSENSUS", data: { statusMessage: "Synthesizing…" } }),
      ev({ agentId: "lead", action: "SPEAKING", data: { message: "Answer!" } }),
      ev({
        agentId: "lead",
        action: "DONE",
        data: { finalAnswer: "Answer!", totalTokens: 123, totalCostUsd: 0.5 },
      }),
    );
    expect(s.phase).toBe("done");
    expect(s.finalAnswer).toBe("Answer!");
    expect(s.totalTokens).toBe(123);
    expect(s.agents.find((a) => a.id === "lead")?.status).toBe("DONE");
    expect(s.agents.every((a) => a.status === "DONE")).toBe(true);
    const finals = s.transcript.filter((t) => t.kind === "final");
    expect(finals).toHaveLength(1);
    expect(s.transcript.filter((t) => t.text === "Answer!")).toHaveLength(1);
  });

  it("ERROR sets phase and message", () => {
    const s = run(
      started(),
      ev({ agentId: "lead", action: "ERROR", data: { message: "budget exceeded" } }),
    );
    expect(s.phase).toBe("error");
    expect(s.error).toBe("budget exceeded");
    expect(s.transcript.at(-1)?.kind).toBe("error");
  });
});
