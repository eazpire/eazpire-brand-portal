import { describe, it, expect } from "vitest";
import { normalizeHandle, HANDLE_RE } from "../../src/features/brands/brandProfile.js";

describe("brand handle", () => {
  it("normalizes names to handles", () => {
    expect(normalizeHandle("My Cool Brand!")).toBe("my-cool-brand");
    expect(normalizeHandle("  ABC  ")).toBe("abc");
  });

  it("validates handle pattern", () => {
    expect(HANDLE_RE.test("my-brand")).toBe(true);
    expect(HANDLE_RE.test("My-Brand")).toBe(false);
    expect(HANDLE_RE.test("-bad")).toBe(false);
  });
});
