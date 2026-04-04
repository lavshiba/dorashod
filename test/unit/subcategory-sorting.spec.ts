import { describe, expect, it } from "vitest";
import { resolveSubcategorySortMode } from "@/db/repository";

describe("resolveSubcategorySortMode", () => {
  it("prefers category override over general mode", () => {
    expect(resolveSubcategorySortMode("alphabet", "usage")).toBe("alphabet");
  });

  it("falls back to general mode when override is empty", () => {
    expect(resolveSubcategorySortMode(null, "recent")).toBe("recent");
  });

  it("ignores unknown override values", () => {
    expect(resolveSubcategorySortMode("weird", "usage")).toBe("usage");
  });
});
