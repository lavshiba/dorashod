import { describe, expect, it, vi } from "vitest";
import type { ParsedEntryAttempt, UiSession, UserRecord } from "@/domain/types";
import { BotService } from "@/services/bot-service";

class FakeRepo {
  session: UiSession = {
    mode: "search",
    stack: ["home"],
    context: { awaiting: "query" }
  };

  enqueued: Array<{ rawText: string; parsed: ParsedEntryAttempt; missing: string[] }> = [];

  async getOrCreateUser(): Promise<UserRecord> {
    return {
      id: 1,
      telegramUserId: "1",
      chatId: "1",
      onboardingStep: 7,
      onboardingCompletedAt: "2026-04-05T00:00:00.000Z",
      timezoneName: "Europe/Moscow",
      timezoneSource: "default",
      currencyCode: "RUB",
      currencyLabel: "₽",
      subcategoriesEnabled: true,
      quickAccessModeExpense: "automatically",
      quickAccessModeIncome: "automatically",
      quickAccessModeSubcategories: "automatically",
      sortModeExpense: "usage",
      sortModeIncome: "usage",
      sortModeSubcategories: "usage"
    };
  }

  async getSession() {
    return {
      mode: this.session.mode,
      stack: [...this.session.stack],
      context: { ...this.session.context }
    };
  }

  async saveSession(_userId: number, session: UiSession) {
    this.session = {
      mode: session.mode,
      stack: [...session.stack],
      context: { ...session.context }
    };
  }

  async enqueueIntake(_userId: number, _source: string, rawText: string, parsed: ParsedEntryAttempt, missing: string[]) {
    this.enqueued.push({ rawText, parsed, missing: [...missing] });
  }
}

class FakeTelegram {
  sends: Array<Record<string, unknown>> = [];
  deletes: Array<{ chatId: string; messageId: number }> = [];

  async sendMessage(payload: Record<string, unknown>) {
    this.sends.push(payload);
    return 700 + this.sends.length;
  }

  async editMessageText(_payload: Record<string, unknown>) {
    throw new Error("edit should not be used in this test");
  }

  async deleteMessage(chatId: string, messageId: number) {
    this.deletes.push({ chatId, messageId });
  }
}

describe("search conflict handling", () => {
  it("shows a conflict screen instead of running search for entry-like text", async () => {
    const repo = new FakeRepo();
    const telegram = new FakeTelegram();
    const service = new BotService(repo as never, telegram as never) as unknown as {
      handleMessage: (fromId: number, chatId: number, text: string, messageId?: number) => Promise<void>;
    };

    await service.handleMessage(1, 1, "-450 продукты пятёрочка хлеб", 10);

    expect(telegram.sends).toHaveLength(1);
    expect(String(telegram.sends[0].text)).toContain("это похоже на новую запись,");
    expect(String(telegram.sends[0].text)).toContain("а не на поисковый запрос");
    expect(repo.session.context.pendingText).toBe("-450 продукты пятёрочка хлеб");
    expect(repo.session.context.awaiting).toBe("query");
    expect(repo.session.context.query).toBeUndefined();
    expect(repo.enqueued).toEqual([]);
  });

  it("moves a batch into queue instead of treating it as a search query", async () => {
    const repo = new FakeRepo();
    const telegram = new FakeTelegram();
    const service = new BotService(repo as never, telegram as never) as unknown as {
      handleMessage: (fromId: number, chatId: number, text: string, messageId?: number) => Promise<void>;
    };

    await service.handleMessage(1, 1, "-450 продукты пятёрочка\n+4000 зарплата премия", 11);

    expect(repo.enqueued).toHaveLength(2);
    expect(telegram.sends).toHaveLength(1);
    expect(String(telegram.sends[0].text)).toContain("это похоже на новые записи");
    expect(String(telegram.sends[0].text)).toContain("я сохранил их в новые записи:\n2");
    expect(String(telegram.sends[0].text)).toContain("поиск не запускал");
  });

  it("still runs a normal search query from the prompt mode", async () => {
    const repo = new FakeRepo();
    const telegram = new FakeTelegram();
    const service = new BotService(repo as never, telegram as never) as unknown as {
      handleMessage: (fromId: number, chatId: number, text: string, messageId?: number) => Promise<void>;
      showSearchResults: (user: UserRecord, query: string, page: number) => Promise<void>;
    };
    service.showSearchResults = vi.fn(async () => {});

    await service.handleMessage(1, 1, "app store 2022", 12);

    expect(service.showSearchResults).toHaveBeenCalledTimes(1);
    expect(service.showSearchResults).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "app store 2022", 0);
    expect(repo.session.context.query).toBe("app store 2022");
    expect(repo.session.context.awaiting).toBeUndefined();
    expect(repo.enqueued).toEqual([]);
  });
});
