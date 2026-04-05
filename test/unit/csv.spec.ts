import { describe, expect, it } from "vitest";
import { parseEntriesImport } from "@/services/bot-service";
import { serializeEntriesCsv } from "@/utils/csv";

describe("serializeEntriesCsv", () => {
  it("serializes export rows with the required header order", () => {
    const csv = serializeEntriesCsv([
      {
        date: "2026-04-05",
        time: "09:30",
        amountMinor: 45075,
        type: "expense",
        category: "Продукты",
        subcategory: "Хлеб",
        description: "Пятёрочка"
      }
    ]);

    expect(csv.split("\n")[0]).toBe("date,time,amount,type,category,subcategory,description");
    expect(csv).toContain("2026-04-05,09:30,450.75,expense,Продукты,Хлеб,Пятёрочка");
  });

  it("round-trips through the CSV import parser", () => {
    const csv = serializeEntriesCsv([
      {
        date: "2026-04-05",
        time: "09:30",
        amountMinor: 45075,
        type: "expense",
        category: "Продукты",
        subcategory: "Хлеб",
        description: "Пятёрочка"
      },
      {
        date: "2026-04-06",
        time: null,
        amountMinor: 120000,
        type: "income",
        category: "Зарплата",
        subcategory: null,
        description: "Аванс"
      }
    ]);

    const parsed = parseEntriesImport(csv);

    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      type: "expense",
      amountMinor: 45075,
      categoryName: "Продукты",
      subcategoryName: "Хлеб",
      description: "Пятёрочка",
      entryDate: "2026-04-05",
      entryTime: "09:30"
    });
    expect(parsed.entries[1]).toMatchObject({
      type: "income",
      amountMinor: 120000,
      categoryName: "Зарплата",
      subcategoryName: null,
      description: "Аванс",
      entryDate: "2026-04-06",
      entryTime: null,
      isTimeAuto: true
    });
  });
});
