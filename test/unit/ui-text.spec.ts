import { describe, expect, it } from "vitest";
import { BUTTONS, ONBOARDING_TEXTS, onboardingProgress } from "@/ui/text";

describe("frozen ui text", () => {
  it("keeps required button labels", () => {
    expect(BUTTONS.edit).toBe("изменить");
    expect(BUTTONS.operations).toBe("операции");
    expect(BUTTONS.restore).toBe("вернуть");
    expect(BUTTONS.saveToFile).toBe("сохранить в файл");
    expect(BUTTONS.loadFromFile).toBe("загрузить из файла");
    expect(BUTTONS.howToUse).toBe("как пользоваться");
  });

  it("renders onboarding progress without numbers", () => {
    expect(onboardingProgress(0)).toBe("● ○ ○ ○ ○ ○ ○");
    expect(onboardingProgress(2)).toBe("● ● ● ○ ○ ○ ○");
    expect(onboardingProgress(6)).toBe("● ● ● ● ● ● ●");
  });

  it("stores all seven onboarding screens", () => {
    expect(ONBOARDING_TEXTS).toHaveLength(7);
  });
});
