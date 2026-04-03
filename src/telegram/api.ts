import type { TelegramDocumentPayload, TelegramMessagePayload } from "@/domain/types";

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
}

export class TelegramApi {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async sendMessage(payload: TelegramMessagePayload): Promise<void> {
    await this.call("sendMessage", {
      ...payload,
      parse_mode: "HTML"
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text
    });
  }

  async setWebhook(url: string): Promise<void> {
    await this.call("setWebhook", { url });
  }

  async getWebhookInfo(): Promise<unknown> {
    return this.call("getWebhookInfo", {});
  }

  async sendDocument(payload: TelegramDocumentPayload): Promise<void> {
    const formData = new FormData();
    formData.set("chat_id", payload.chat_id);
    formData.set("caption", payload.caption ?? "");
    formData.set(
      "document",
      new File([payload.content], payload.filename, {
        type: "application/json"
      })
    );

    const response = await fetch(`${this.baseUrl}/sendDocument`, {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      throw new Error(`Telegram API sendDocument failed with ${response.status}`);
    }

    const body = (await response.json()) as TelegramApiResponse<unknown>;
    if (!body.ok) {
      throw new Error("Telegram API sendDocument returned ok=false");
    }
  }

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Telegram API ${method} failed with ${response.status}`);
    }

    const body = (await response.json()) as TelegramApiResponse<T>;
    if (!body.ok) {
      throw new Error(`Telegram API ${method} returned ok=false`);
    }

    return body.result;
  }
}
