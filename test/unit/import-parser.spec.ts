import { describe, expect, it } from "vitest";
import { parseEntriesImport } from "@/services/bot-service";

describe("parseEntriesImport", () => {
  it("parses semicolon csv with russian headers and decimal comma", () => {
    const csv = [
      "Дата;Время;Сумма;Тип;Категория;Подкатегория;Описание",
      "04.04.2026;13:45:10;450,75;расход;Продукты;Хлеб;Пятёрочка"
    ].join("\n");

    const result = parseEntriesImport(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
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

  it("collects error when category is missing", () => {
    const csv = [
      "type,amount,date",
      "income,1000,2026-04-04"
    ].join("\n");

    const result = parseEntriesImport(csv);
    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(String(result.errors[0].reason)).toContain("категорию");
  });

  it("treats unsigned amount as income when type column is missing", () => {
    const csv = [
      "date,amount,category,description",
      "2026-04-04,200500,Зарплата,Аванс"
    ].join("\n");

    const result = parseEntriesImport(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      type: "income",
      amountMinor: 20050000,
      categoryName: "Зарплата",
      description: "Аванс"
    });
  });

  it("splits combined category path into category and subcategory", () => {
    const csv = [
      "date,amount,category",
      "2026-04-04,-450,\"Продукты, Пятёрочка\""
    ].join("\n");

    const result = parseEntriesImport(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      type: "expense",
      amountMinor: 45000,
      categoryName: "Продукты",
      subcategoryName: "Пятёрочка"
    });
  });

  it("keeps amount_minor as minor units", () => {
    const csv = [
      "date,amount minor,category",
      "2026-04-04,12345,Перевод"
    ].join("\n");

    const result = parseEntriesImport(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      type: "income",
      amountMinor: 12345,
      categoryName: "Перевод"
    });
  });
});
