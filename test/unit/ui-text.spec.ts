import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUTTONS, ONBOARDING_TEXTS, REPO_LOCAL_UI_SOURCE, onboardingProgress } from "@/ui/text";

describe("frozen ui text", () => {
  const frozenText = readFileSync(resolve(process.cwd(), REPO_LOCAL_UI_SOURCE), "utf-8");

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

  it("uses the repo-local frozen source file", () => {
    expect(REPO_LOCAL_UI_SOURCE).toBe("docs/frozen/ui-texts.txt");
    expect(frozenText).toContain("замороженные тексты экранов — telegram-бот «финансы»");
  });

  it("keeps key frozen screens in the repo-local source", () => {
    expect(frozenText).toContain("пустая стартовая главная");
    expect(frozenText).toContain("пока записей нет");
    expect(frozenText).toContain("[как пользоваться]");
    expect(frozenText).toContain("в другие приложения");
    expect(frozenText).toContain("кнопки:\n[сохранить в файл]\n[загрузить из файла]");
  });

  it("matches onboarding copy against the frozen source", () => {
    for (const screen of ONBOARDING_TEXTS) {
      expect(frozenText).toContain(screen);
    }
  });
});
