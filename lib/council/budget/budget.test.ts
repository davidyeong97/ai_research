import { describe, expect, it } from "vitest";
import { BudgetExceeded, BudgetTracker, defaultBudgetCap } from "./index";

describe("defaultBudgetCap", () => {
  it("follows README 4.1", () => {
    expect([1, 2, 3, 4, 5].map(defaultBudgetCap)).toEqual([10_000, 10_000, 30_000, 30_000, 50_000]);
  });
  it("rejects NaN", () => expect(() => defaultBudgetCap(NaN)).toThrow(RangeError));
});

describe("BudgetTracker", () => {
  it("tracks usage, ledger and ratio", () => {
    const b = BudgetTracker.forComplexity(1);
    b.record({ promptTokens: 1000, completionTokens: 1500 }, "wizard");
    b.record({ promptTokens: 500, completionTokens: 0 }, "wizard");
    b.record({ promptTokens: 0, completionTokens: 2000 }, "rogue");
    expect(b.used).toBe(5000);
    expect(b.remaining).toBe(5000);
    expect(b.remainingRatio).toBe(0.5);
    expect(b.agentUsage("wizard")).toEqual({
      promptTokens: 1500,
      completionTokens: 1500,
      totalTokens: 3000,
      calls: 2,
    });
    expect(b.agentUsage("nobody").totalTokens).toBe(0);
    expect(b.snapshot().agents.rogue.totalTokens).toBe(2000);
  });

  it("canSpend respects the cap", () => {
    const b = new BudgetTracker(100);
    expect(b.canSpend(100)).toBe(true);
    expect(b.canSpend(101)).toBe(false);
    expect(b.canSpend(-1)).toBe(false);
    b.record({ promptTokens: 60, completionTokens: 0 });
    expect(b.canSpend(40)).toBe(true);
    expect(b.canSpend(41)).toBe(false);
  });

  it("assertCanSpend throws typed error", () => {
    const b = new BudgetTracker(100);
    try {
      b.assertCanSpend(150, "scout");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceeded);
      expect((e as BudgetExceeded).cap).toBe(100);
      expect((e as BudgetExceeded).agentId).toBe("scout");
    }
  });

  it("record over the cap still accounts then throws; ratio clamps to 0", () => {
    const b = new BudgetTracker(100);
    expect(() => b.record({ promptTokens: 80, completionTokens: 40 }, "a")).toThrow(BudgetExceeded);
    expect(b.used).toBe(120);
    expect(b.remainingRatio).toBe(0);
    expect(b.exhausted).toBe(true);
    expect(b.agentUsage("a").totalTokens).toBe(120);
  });

  it("validates input", () => {
    expect(() => new BudgetTracker(0)).toThrow(RangeError);
    expect(() => new BudgetTracker(10).record({ promptTokens: -1, completionTokens: 0 })).toThrow(
      RangeError,
    );
  });
});
