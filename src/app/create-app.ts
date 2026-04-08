import { Hono } from "hono";
import type { Env as HonoEnv } from "hono";
import { parseEnv } from "@/config/env";
import { Repository } from "@/db/repository";
import { BotService } from "@/services/bot-service";
import { TelegramApi } from "@/telegram/api";

type Bindings = {
  APP_ENV: string;
  BOT_NAME: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_WEBHOOK_TOKEN: string;
  HEALTH_TOKEN: string;
  DB: D1Database;
};

export function createApp() {
  const app = new Hono<HonoEnv & { Bindings: Bindings }>();

  app.get("/health", async (c) => {
    const env = parseEnv(c.env);
    const repo = new Repository(env.DB);
    const dbOk = await repo.healthCheck();
    return c.json(
      {
        ok: dbOk,
        service: "finance-bot"
      },
      dbOk ? 200 : 503
    );
  });

  app.get("/diagnostics", async (c) => {
    const env = parseEnv(c.env);
    const auth = c.req.header("authorization");
    if (auth !== `Bearer ${env.HEALTH_TOKEN}`) {
      return c.json({ ok: false }, 401);
    }
    const repo = new Repository(env.DB);
    return c.json({
      ok: true,
      dbOk: await repo.healthCheck(),
      diagnostics: await repo.getDiagnostics()
    });
  });

  app.post("/webhook/telegram/:secret", async (c) => {
    const env = parseEnv(c.env);
    if (c.req.param("secret") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return c.json({ ok: false }, 403);
    }
    if (c.req.header("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_TOKEN) {
      return c.json({ ok: false }, 401);
    }
    const update = await c.req.json();
    const bot = new BotService(new Repository(env.DB), new TelegramApi(env.TELEGRAM_BOT_TOKEN));
    try {
      await bot.handleUpdate(update);
    } catch (error) {
      console.error("telegram webhook failed", error);
      return c.json({ ok: false }, 500);
    }
    return c.json({ ok: true });
  });

  app.get("/", (c) => c.text("finance-bot"));

  return app;
}
