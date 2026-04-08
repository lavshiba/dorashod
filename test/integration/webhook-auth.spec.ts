import { describe, expect, it } from "vitest";
import { createApp } from "@/app/create-app";

class FakeStatement {
  bind(..._args: unknown[]) {
    return this;
  }

  async first<T>() {
    return { ok: 1 } as T;
  }

  async all<T>() {
    return { results: [] as T[] };
  }

  async run() {
    return { success: true };
  }
}

class FakeDb {
  prepare(_query: string) {
    return new FakeStatement();
  }
}

const bindings = {
  APP_ENV: "test",
  BOT_NAME: "финансы",
  TELEGRAM_BOT_TOKEN: "x",
  TELEGRAM_WEBHOOK_SECRET: "path-secret",
  TELEGRAM_WEBHOOK_TOKEN: "header-secret",
  HEALTH_TOKEN: "health",
  DB: new FakeDb() as unknown as D1Database
};

describe("telegram webhook auth", () => {
  it("rejects requests with invalid path secret", async () => {
    const app = createApp();
    const response = await app.request("http://local/webhook/telegram/wrong", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "header-secret"
      },
      body: JSON.stringify({ update_id: 1 })
    }, bindings);

    expect(response.status).toBe(403);
  });

  it("rejects requests without telegram secret token", async () => {
    const app = createApp();
    const response = await app.request("http://local/webhook/telegram/path-secret", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ update_id: 1 })
    }, bindings);

    expect(response.status).toBe(401);
  });
});
