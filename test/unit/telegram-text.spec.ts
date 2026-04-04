import { describe, expect, it } from "vitest";
import { formatTelegramScreenText, isTelegramMessageNotModified } from "@/utils/telegram-text";

describe("telegram screen text", () => {
  it("keeps exact manual line breaks from frozen screens", () => {
    expect(formatTelegramScreenText("пока записей нет\nможно добавить доход\nили просто написать запись")).toBe(
      "пока записей нет\nможно добавить доход\nили просто написать запись"
    );
  });

  it("keeps existing paragraph spacing compact", () => {
    expect(formatTelegramScreenText("финансы\n\nтекст\n\n\n\nещё")).toBe("финансы\n\nтекст\n\nещё");
  });

  it("recognizes not modified telegram errors", () => {
    expect(isTelegramMessageNotModified(new Error("Telegram API editMessageText returned ok=false: Bad Request: message is not modified"))).toBe(true);
    expect(isTelegramMessageNotModified(new Error("Telegram API editMessageText returned ok=false: Bad Request: chat not found"))).toBe(false);
  });
});
