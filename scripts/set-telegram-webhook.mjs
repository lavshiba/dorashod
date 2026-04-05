const token = process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
const baseUrl = process.env.POST_DEPLOY_BASE_URL;

if (!token || !webhookSecret || !baseUrl) {
  throw new Error("TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and POST_DEPLOY_BASE_URL are required");
}

const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
const webhookUrl = `${normalizedBaseUrl}/webhook/telegram/${webhookSecret}`;
const telegramBaseUrl = `https://api.telegram.org/bot${token}`;

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

await telegramCall("setWebhook", { url: webhookUrl });
const info = await telegramCall("getWebhookInfo", {});

if (info.url !== webhookUrl) {
  throw new Error(`Webhook URL mismatch: expected ${webhookUrl}, got ${info.url}`);
}

console.log(`Webhook configured: ${webhookUrl}`);
