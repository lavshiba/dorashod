import { describe, expect, it } from "vitest";
import { stageImportFixPreview } from "@/services/bot-service";

describe("stageImportFixPreview", () => {
  it("moves a corrected line into preview entries", () => {
    const preview = {
      entries: [],
      errors: [
        {
          rawText: "-450 продукты пятёрочка хлеб 2026-04-04 13:45",
          reason: "не удалось понять строку"
        }
      ]
    };

    const staged = stageImportFixPreview(preview, 0);

    expect(staged.status).toBe("saved");
    expect(staged.preview.errors).toHaveLength(0);
    expect(staged.preview.entries).toHaveLength(1);
    expect(staged.preview.entries[0]).toMatchObject({
      type: "expense",
      amountMinor: 45000,
      categoryName: "продукты",
      subcategoryName: "пятёрочка",
      entryDate: "2026-04-04",
      entryTime: "13:45",
      isTimeAuto: false,
      isDateMissing: false
    });
  });

  it("keeps the row in errors when required fields are still missing", () => {
    const preview = {
      entries: [],
      errors: [
        {
          rawText: "+4000",
          reason: "не хватает полей"
        }
      ]
    };

    const staged = stageImportFixPreview(preview, 0);

    expect(staged.status).toBe("missing");
    expect(staged.preview.errors).toHaveLength(1);
    expect(staged.preview.entries).toHaveLength(0);
  });
});
