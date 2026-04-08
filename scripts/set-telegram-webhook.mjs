const token = process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
const webhookToken = process.env.TELEGRAM_WEBHOOK_TOKEN;
const baseUrl = process.env.POST_DEPLOY_BASE_URL;

if (!token || !webhookSecret || !webhookToken || !baseUrl) {
  const missing = [
    !token ? "TELEGRAM_BOT_TOKEN" : null,
    !webhookSecret ? "TELEGRAM_WEBHOOK_SECRET" : null,
    !webhookToken ? "TELEGRAM_WEBHOOK_TOKEN" : null,
    !baseUrl ? "POST_DEPLOY_BASE_URL" : null
  ].filter(Boolean);
  throw new Error(`Missing required env: ${missing.join(", ")}`);
}

const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
const webhookUrl = `${normalizedBaseUrl}/webhook/telegram/${webhookSecret}`;
const telegramBaseUrl = `https://api.telegram.org/bot${token}`;

function maskWebhookUrl(url) {
  try {
    const parsed = new globalThis.URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length > 0) {
      parts[parts.length - 1] = "***";
    }
    return `${parsed.origin}/${parts.join("/")}`;
  } catch {
    return "<invalid-webhook-url>";
  }
}

async function telegramCall(method, payload) {
  const response = await fetch(`${telegramBaseUrl}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Telegram API ${method} failed with ${response.status}`);
  }

  const body = await response.json();
  if (!body.ok) {
    throw new Error(body.description ?? `Telegram API ${method} returned ok=false`);
  }

  return body.result;
}

await telegramCall("setWebhook", { url: webhookUrl, secret_token: webhookToken });
const info = await telegramCall("getWebhookInfo", {});

if (info.url !== webhookUrl) {
  throw new Error(`Webhook URL mismatch: expected ${maskWebhookUrl(webhookUrl)}, got ${maskWebhookUrl(String(info.url ?? ""))}`);
}

console.log(`Webhook configured for ${new globalThis.URL(normalizedBaseUrl).origin}`);
