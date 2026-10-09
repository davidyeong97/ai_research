import { describe, expect, it } from "vitest";
import { MockLLMClient } from "../llm";
import { buildPlan, LeadOrchestrator, parseClassification } from "./index";

const reply = (domain: string, complexity: number) => JSON.stringify({ domain, complexity });
const run = (domain: string, complexity: number) =>
  new LeadOrchestrator({
    llm: new MockLLMClient(reply(domain, complexity)),
    idFactory: () => "t1",
  }).plan("q");

describe("LeadOrchestrator", () => {
  it.each([
    [1, 1, 1, false],
    [2, 2, 1, false],
    [3, 3, 2, false],
    [4, 3, 2, false],
    [5, 4, 3, true],
  ])("complexity %i", async (c, maxAgents, rounds, approval) => {
    const p = await run("coding", c);
    expect(p.complexityScore).toBe(c);
    expect(p.executionPlan.maxRounds).toBe(rounds);
    expect(p.executionPlan.assignedAgents.length).toBeLessThanOrEqual(maxAgents);
    expect(p.executionPlan.assignedAgents.length).toBeGreaterThanOrEqual(
      c === 5 ? 3 : c >= 3 ? 2 : 1,
    );
    expect(p.requiresApproval === true).toBe(approval);
    expect(new Set(p.executionPlan.assignedAgents.map((a) => a.model)).size).toBe(
      p.executionPlan.assignedAgents.length,
    );
  });

  it("tolerates fenced JSON and retries once", async () => {
    const llm = new MockLLMClient().enqueue(
      "nonsense",
      "```json\n" + reply("Science", 3.2) + "\n```",
    );
    const p = await new LeadOrchestrator({ llm }).plan("q");
    expect(p.complexityScore).toBe(3);
    expect(llm.calls).toHaveLength(2);
  });

  it("throws after failed retries, or uses fallback", async () => {
    await expect(
      new LeadOrchestrator({ llm: new MockLLMClient("bad") }).plan("q"),
    ).rejects.toThrow();
    const p = await new LeadOrchestrator({
      llm: new MockLLMClient("bad"),
      fallback: { domain: "casual", complexity: 2 },
    }).plan("q");
    expect(p.complexityScore).toBe(2);
  });

  it("rejects invalid classification", () => {
    expect(() => parseClassification(reply("cooking", 3))).toThrow();
    expect(() => parseClassification(reply("coding", 9))).toThrow();
  });

  it("prefers domain specialists and includes fallbacks", () => {
    const p = buildPlan({ domain: "creative", complexity: 2 }, { taskId: "x" });
    expect(p.executionPlan.assignedAgents[0].fallbackModels.length).toBeGreaterThan(0);
  });
});

describe("parseClassification robustness", () => {
  const ok = { domain: "coding", complexity: 4 };
  it.each([
    ["fenced", "```json\n" + JSON.stringify({ ...ok, reasoning: "x" }) + "\n```"],
    ["prose around", 'Here you go: {"domain":"coding","complexity":4} Done.'],
    ["echoed braces", 'You asked {"a":1} and a{b}c. {"domain":"coding","complexity":4}'],
    [
      "braces in reasoning",
      '{"domain":"coding","complexity":4,"reasoning":"uses } and { and \\"q\\""}',
    ],
    ["unescaped quotes", '{"domain":"coding","complexity":4,"reasoning":"the "x" thing"}'],
    ["trailing comma", '{"domain":"coding","complexity":4,}'],
    ["truncated", '{"domain":"coding","complexity":4,"reasoning":"cut o'],
    ["single quotes", "{'domain':'coding','complexity':4}"],
  ])("%s", (_n, text) => {
    expect(parseClassification(text)).toMatchObject(ok);
  });

  it("falls back to the safe classification via caller fallback", async () => {
    const p = await new LeadOrchestrator({
      llm: new MockLLMClient('{{{ ``` "unterminated'),
      fallback: { domain: "reasoning", complexity: 3 },
    }).plan("a{b}c");
    expect(p.complexityScore).toBe(3);
  });

  it("wraps the query in an untrusted block and requests json mode", async () => {
    const llm = new MockLLMClient(reply("coding", 2));
    await new LeadOrchestrator({ llm }).classify('{"a":1} <b>');
    const call = llm.calls[0];
    expect(call.maxTokens).toBeGreaterThanOrEqual(800);
    expect(call.jsonMode).toBe(true);
    expect(String(call.messages[1].content)).toContain("<user_query>");
  });
});
