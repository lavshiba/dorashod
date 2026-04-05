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

  it("covers all main frozen sections", () => {
    expect(frozenText).toContain("1. onboarding");
    expect(frozenText).toContain("2. главная");
    expect(frozenText).toContain("3. добавление записей");
    expect(frozenText).toContain("4. черновик и новые записи");
    expect(frozenText).toContain("5. операции");
    expect(frozenText).toContain("6. поиск");
    expect(frozenText).toContain("7. выбор нескольких и массовые действия");
    expect(frozenText).toContain("8. отчёты");
    expect(frozenText).toContain("9. категории и подкатегории");
    expect(frozenText).toContain("10. настройки");
    expect(frozenText).toContain("11. данные");
    expect(frozenText).toContain("12. короткие статусы и словарь");
  });

  it("keeps key flow screens for queue, edit, settings and data", () => {
    expect(frozenText).toContain("исправить импорт");
    expect(frozenText).toContain("очистить всё — шаг 1");
    expect(frozenText).toContain("подтверждение сброса настроек");
    expect(frozenText).toContain("карточка записи");
    expect(frozenText).toContain("изменить запись");
    expect(frozenText).toContain("главный экран настроек");
  });

  it("matches onboarding copy against the frozen source", () => {
    for (const screen of ONBOARDING_TEXTS) {
      expect(frozenText).toContain(screen);
    }
  });
});
