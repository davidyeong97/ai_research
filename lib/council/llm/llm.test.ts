import { describe, expect, it } from "vitest";
import { MockLLMClient, collectChat } from "./index";

const base = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100 };

describe("MockLLMClient", () => {
  it("streams text, reasoning and usage", async () => {
    const c = new MockLLMClient({
      text: "hello big world",
      reasoning: "hmm",
      usage: { costUsd: 0.01 },
    });
    const r = await collectChat(c.streamChat({ ...base, models: ["a/x", "b/y"] }));
    expect(r.text).toBe("hello big world");
    expect(r.reasoning).toBe("hmm");
    expect(r.usage).toMatchObject({ costUsd: 0.01, modelUsed: "a/x" });
    expect(r.fallback).toBeUndefined();
  });

  it("emits fallback when modelUsed differs from primary", async () => {
    const c = new MockLLMClient().enqueue({ text: "ok", modelUsed: "b/y" });
    const chunks = [];
    for await (const ch of c.streamChat({ ...base, models: ["a/x", "b/y"] })) chunks.push(ch);
    expect(chunks.map((x) => x.type)).toEqual(["text", "fallback", "usage"]);
    expect(chunks[1]).toEqual({ type: "fallback", primary: "a/x", modelUsed: "b/y" });
  });

  it("records calls and propagates errors", async () => {
    const c = new MockLLMClient().enqueue({ error: new Error("boom") });
    await expect(collectChat(c.streamChat({ ...base, models: ["a/x"] }))).rejects.toThrow("boom");
    expect(c.calls).toHaveLength(1);
  });
});
