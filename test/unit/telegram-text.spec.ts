import { describe, expect, it } from "vitest";
import { formatTelegramScreenText, isTelegramMessageNotModified } from "@/utils/telegram-text";

describe("telegram screen text", () => {
  it("adds air between single-line blocks without changing wording", () => {
    expect(formatTelegramScreenText("пока записей нет\nможно добавить доход\nили просто написать запись")).toBe(
      "пока записей нет\n\nможно добавить доход\n\nили просто написать запись"
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
