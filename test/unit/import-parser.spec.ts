import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { makeEntryDedupKey, parseEntriesImport } from "@/services/data-import";

function readFixture(name: string): string {
  return readFileSync(resolve(process.cwd(), "test/fixtures/import", name), "utf8");
}

describe("parseEntriesImport", () => {
  it("parses semicolon csv with russian headers and decimal comma", () => {
    const result = parseEntriesImport(readFixture("file_with_decimal_comma.csv"));

    expect(result.errors).toHaveLength(0);
    expect(result.meta.recognizedColumns).toEqual(["amount", "category", "subcategory", "description", "date"]);
    expect(result.entries[0]).toMatchObject({
      type: "expense",
      amountMinor: 45075,
      categoryName: "Продукты",
      subcategoryName: "Хлеб",
      description: "Пятёрочка",
      entryDate: "2026-04-04",
      entryTime: "13:45",
      isTimeAuto: false,
      isDateMissing: false
    });
  });

  it("parses english external headers without exact casing", () => {
    const result = parseEntriesImport(`\uFEFFsum,CATEGORY,Subcategory,NOTE,Date\n${readFixture("filki_en_headers.csv").split("\n")[1]}`);

    expect(result.errors).toHaveLength(0);
    expect(result.meta.validRows).toBe(1);
    expect(result.entries[0]).toMatchObject({
      type: "expense",
      amountMinor: 45000,
      categoryName: "products",
      subcategoryName: "pyaterochka",
      description: "Bread",
      entryDate: "2026-04-04",
      entryTime: "13:45"
    });
  });

  it("parses russian external headers", () => {
    const result = parseEntriesImport(readFixture("filki_ru_headers.csv"));

    expect(result.errors).toHaveLength(0);
    expect(result.meta.validRows).toBe(1);
    expect(result.entries[0]).toMatchObject({
      type: "expense",
      amountMinor: 45000,
      categoryName: "Продукты",
      subcategoryName: "Пятёрочка",
      description: "Хлеб"
    });
  });

  it("treats null-like values as empty fields", () => {
    const result = parseEntriesImport(readFixture("file_with_nulls.csv"));

    expect(result.errors).toHaveLength(0);
    expect(result.entries[0]).toMatchObject({
      categoryName: "Подписки",
      subcategoryName: null,
      description: null,
      entryDate: "2026-04-04",
      entryTime: null,
      isTimeAuto: true
    });
  });

  it("accepts datetimes with seconds", () => {
    const result = parseEntriesImport(readFixture("file_with_datetime_seconds.csv"));

    expect(result.errors).toHaveLength(0);
    expect(result.entries[0]).toMatchObject({
      entryDate: "2026-04-04",
      entryTime: "07:08"
    });
  });

  it("infers type from signed amount and keeps unreadable date as missing", () => {
    const csv = [
      "datetime,amount,category,description",
      "непонятно,-1200,Транспорт,Метро"
    ].join("\n");

    const result = parseEntriesImport(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      type: "expense",
      amountMinor: 120000,
      categoryName: "Транспорт",
      description: "Метро",
      entryDate: null,
      entryTime: null,
      isTimeAuto: true,
      isDateMissing: true
    });
  });

  it("reports missing required header columns explicitly", () => {
    const csv = [
      "Type,Note",
      "expense,Кофе"
    ].join("\n");

    const result = parseEntriesImport(csv);

    expect(result.entries).toHaveLength(0);
    expect(result.meta.missingRequiredColumns).toEqual(["amount", "category", "date"]);
    expect(result.errors.map((item) => String(item.reason))).toEqual([
      "не распознана колонка суммы",
      "не распознана колонка категории",
      "не распознана колонка даты"
    ]);
  });

  it("keeps amount_minor as minor units", () => {
    const csv = [
      "date,amount minor,category",
      "2026-04-04,12345,Перевод"
    ].join("\n");

    const result = parseEntriesImport(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.entries[0]).toMatchObject({
      type: "income",
      amountMinor: 12345,
      categoryName: "Перевод"
    });
  });
});

describe("makeEntryDedupKey", () => {
  it("normalizes category, subcategory and description", () => {
    const left = makeEntryDedupKey({
      type: "expense",
      amountMinor: 45000,
      entryDate: "2026-04-04",
      entryTime: "13:45",
      categoryName: " Продукты ",
      subcategoryName: "Пятёрочка",
      description: " ХЛЕБ "
    });
    const right = makeEntryDedupKey({
      type: "expense",
      amountMinor: 45000,
      entryDate: "2026-04-04",
      entryTime: "13:45",
      categoryName: "продукты",
      subcategoryName: "Пятерочка",
      description: "хлеб"
    });

    expect(left).toBe(right);
  });
});
