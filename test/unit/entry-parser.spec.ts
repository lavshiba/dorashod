import { describe, expect, it } from "vitest";
import { parseEntryAttempt } from "@/utils/entry-parser";

describe("parseEntryAttempt", () => {
  it("parses complete expense message", () => {
    const parsed = parseEntryAttempt("-450 продукты пятёрочка хлеб");
    expect(parsed.type).toBe("expense");
    expect(parsed.amountMinor).toBe(45000);
    expect(parsed.category).toBe("продукты");
    expect(parsed.subcategory).toBe("пятёрочка");
    expect(parsed.description).toBe("хлеб");
    expect(parsed.missing).toEqual([]);
  });

  it("detects incomplete message", () => {
    const parsed = parseEntryAttempt("+4000");
    expect(parsed.type).toBe("income");
    expect(parsed.amountMinor).toBe(400000);
    expect(parsed.missing).toEqual(["category"]);
  });

  it("detects batch input", () => {
    const parsed = parseEntryAttempt("-450 продукты\n+4000 зарплата");
    expect(parsed.isBatch).toBe(true);
    expect(parsed.lines).toHaveLength(2);
  });
});
