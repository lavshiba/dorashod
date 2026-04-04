import { describe, expect, it } from "vitest";
import { buildCategoryTransferPlan } from "@/db/repository";

describe("buildCategoryTransferPlan", () => {
  it("clears subcategory when target category does not have a visible matching subcategory", () => {
    const plan = buildCategoryTransferPlan(
      [
        { id: 1, subcategoryNormalizedName: "coffee" },
        { id: 2, subcategoryNormalizedName: "groceries" },
        { id: 3, subcategoryNormalizedName: null }
      ],
      new Map([["groceries", 42]])
    );

    expect(plan.movedCount).toBe(3);
    expect(plan.clearedSubcategoryCount).toBe(1);
    expect(plan.updates).toEqual([
      { entryId: 1, targetSubcategoryId: null },
      { entryId: 2, targetSubcategoryId: 42 },
      { entryId: 3, targetSubcategoryId: null }
    ]);
  });
});
