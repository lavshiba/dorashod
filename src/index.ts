import { createApp } from "@/app/create-app";
import { parseEnv } from "@/config/env";
import { Repository } from "@/db/repository";
import { BotService } from "@/services/bot-service";
import { TelegramApi } from "@/telegram/api";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: unknown, _ctx: ExecutionContext) {
    const parsed = parseEnv(env);
    const bot = new BotService(new Repository(parsed.DB), new TelegramApi(parsed.TELEGRAM_BOT_TOKEN));
    try {
      await bot.runCron("scheduled");
    } catch (error) {
      console.error("scheduled failed", error);
      throw error;
    }
  }
};
