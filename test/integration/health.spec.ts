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

describe("health endpoint", () => {
  it("returns worker and db status", async () => {
    const app = createApp();
    const response = await app.request("http://local/health", {}, {
      APP_ENV: "test",
      BOT_NAME: "финансы",
      TELEGRAM_BOT_TOKEN: "x",
      TELEGRAM_WEBHOOK_SECRET: "secret",
      HEALTH_TOKEN: "health",
      BACKUP_SIGNING_KEY: "backup",
      DB: new FakeDb() as unknown as D1Database
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; dbOk: boolean };
    expect(body.ok).toBe(true);
    expect(body.dbOk).toBe(true);
  });
});
