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
