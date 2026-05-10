import { z } from "zod";

const envSchema = z.object({
  APP_ENV: z.string().default("development"),
  BOT_NAME: z.string().default("финансы"),
  BOT_MODE: z.string().default("legacy"),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  TELEGRAM_WEBHOOK_TOKEN: z.string().min(1),
  HEALTH_TOKEN: z.string().min(1),
  APPS_SCRIPT_AUTH_TOKEN: z.string().default(""),
  DB: z.custom<D1Database>()
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: unknown): Env {
  return envSchema.parse(raw);
}
