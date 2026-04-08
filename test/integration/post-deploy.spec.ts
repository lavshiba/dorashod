import { describe, expect, it } from "vitest";

const baseUrl = process.env.POST_DEPLOY_BASE_URL;
const webhookSecret = process.env.POST_DEPLOY_WEBHOOK_SECRET;
const webhookToken = process.env.POST_DEPLOY_WEBHOOK_TOKEN;
const healthToken = process.env.POST_DEPLOY_HEALTH_TOKEN;

describe("post deploy smoke", () => {
  it.skipIf(!baseUrl)("checks health endpoint", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.ok).toBe(true);
  });

  it.skipIf(!baseUrl || !healthToken)("checks diagnostics endpoint", async () => {
    const response = await fetch(`${baseUrl}/diagnostics`, {
      headers: {
        authorization: `Bearer ${healthToken}`
      }
    });
    expect(response.ok).toBe(true);
  });

  it.skipIf(!baseUrl || !healthToken)("checks diagnostics auth is enforced", async () => {
    const response = await fetch(`${baseUrl}/diagnostics`);
    expect(response.status).toBe(401);
  });

  it.skipIf(!baseUrl || !webhookSecret || !webhookToken)("checks webhook path exists", async () => {
    const response = await fetch(`${baseUrl}/webhook/telegram/${webhookSecret}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": webhookToken as string
      },
      body: JSON.stringify({ update_id: 1 })
    });
    expect([200, 500]).toContain(response.status);
  });

  it.skipIf(!baseUrl || !webhookSecret)("checks webhook token is enforced", async () => {
    const response = await fetch(`${baseUrl}/webhook/telegram/${webhookSecret}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ update_id: 1 })
    });
    expect(response.status).toBe(401);
  });
});
