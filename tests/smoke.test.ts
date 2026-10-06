import { describe, expect, it } from "vitest";
import { COUNCIL_NAME } from "@/lib/council";

describe("smoke", () => {
  it("resolves path aliases", () => {
    expect(COUNCIL_NAME).toBe("council");
  });
});
