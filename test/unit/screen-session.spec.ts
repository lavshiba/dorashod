import { describe, expect, it } from "vitest";
import { BotService } from "@/services/bot-service";

class FakeRepo {
  session: { mode: string; stack: string[]; context: Record<string, unknown> } = {
    mode: "idle",
    stack: [],
    context: {} as Record<string, unknown>
  };

  async getSession() {
    return {
      mode: this.session.mode,
      stack: [...this.session.stack],
      context: { ...this.session.context }
    };
  }

  async saveSession(_userId: number, session: { mode: string; stack: string[]; context: Record<string, unknown> }) {
    this.session = {
      mode: session.mode,
      stack: [...session.stack],
      context: { ...session.context }
    };
  }
}

class FakeTelegram {
  edits: Array<Record<string, unknown>> = [];
  sends: Array<Record<string, unknown>> = [];
  deletes: Array<{ chatId: string; messageId: number }> = [];

  async sendMessage(payload: Record<string, unknown>) {
    this.sends.push(payload);
    return 777;
  }

  async editMessageText(payload: Record<string, unknown>) {
    this.edits.push(payload);
  }

  async deleteMessage(chatId: string, messageId: number) {
    this.deletes.push({ chatId, messageId });
  }
}

describe("single-screen helpers", () => {
  it("edits the existing inline screen instead of sending a new message", async () => {
    const repo = new FakeRepo();
    repo.session.context.screenMessageId = 55;
    const telegram = new FakeTelegram();
    const service = new BotService(repo as never, telegram as never) as unknown as {
      currentUserId: number | null;
      sendMessage: (payload: Record<string, unknown>) => Promise<void>;
    };

    service.currentUserId = 1;

    await service.sendMessage({
      chat_id: "1",
      text: "<b>финансы</b>\n\nглавная",
      reply_markup: {
        inline_keyboard: [[{ text: "главная", callback_data: "a=nav%3Ahome" }]]
      }
    });

    expect(telegram.edits).toHaveLength(1);
    expect(telegram.sends).toHaveLength(0);
    expect(repo.session.context.screenMessageId).toBe(55);
  });

  it("clearSessionKeepingScreen keeps screenMessageId while resetting flow state", async () => {
    const repo = new FakeRepo();
    repo.session = {
      mode: "search",
      stack: ["home"],
      context: {
        screenMessageId: 99,
        query: "кофе"
      }
    };
    const telegram = new FakeTelegram();
    const service = new BotService(repo as never, telegram as never) as unknown as {
      clearSessionKeepingScreen: (userId: number) => Promise<void>;
    };

    await service.clearSessionKeepingScreen(1);

    expect(repo.session.mode).toBe("idle");
    expect(repo.session.stack).toEqual([]);
    expect(repo.session.context).toEqual({ screenMessageId: 99 });
  });
});
