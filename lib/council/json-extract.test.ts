import { describe, expect, it } from "vitest";
import { extractJson, extractJsonCandidates } from "./json-extract";

const hasA = (v: unknown) =>
  v && typeof v === "object" && "a" in (v as object) ? (v as { a: unknown }) : undefined;

describe("json-extract", () => {
  it.each([
    ['```json\n{"a":1}\n```', 1],
    ['Sure! {"a":2} hope that helps', 2],
    ['You wrote {x} and f(a{b}c). {"a":3}', 3],
    ['{"a":4,"r":"has } and { inside"}', 4],
    ['{"a":5,}', 5],
    ["{'a': 6}", 6],
    ['{"a":7,"r":"nested \\"q\\" {x}"}', 7],
  ])("extracts %s", (t, n) => {
    expect(extractJson(t, hasA)?.a).toBe(n);
  });
  it("returns undefined for truncated or empty", () => {
    expect(extractJson('{"a":1, "r":"cut', hasA)).toBeUndefined();
    expect(extractJsonCandidates("no json")).toEqual([]);
  });
  it("extracts arrays", () => {
    expect(extractJsonCandidates("x [1,2] y", "[")).toEqual([[1, 2]]);
  });
});
