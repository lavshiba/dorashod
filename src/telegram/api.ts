import type { TelegramDocumentPayload, TelegramEditMessagePayload, TelegramMessagePayload } from "@/domain/types";

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

export class TelegramApi {
  private readonly baseUrl: string;
  private readonly fileBaseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
  }

  async sendMessage(payload: TelegramMessagePayload): Promise<number> {
    const result = await this.call<{ message_id: number }>("sendMessage", {
      ...payload,
      parse_mode: "HTML"
    });
    return result.message_id;
  }

  async editMessageText(payload: TelegramEditMessagePayload): Promise<void> {
    await this.call("editMessageText", {
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

  async downloadTextFile(fileId: string): Promise<{ filePath: string; content: string }> {
    const file = await this.call<{ file_path: string }>("getFile", {
      file_id: fileId
    });
    const filePath = file.file_path;
    const response = await fetch(`${this.fileBaseUrl}/${filePath}`);
    if (!response.ok) {
      throw new Error(`Telegram file download failed with ${response.status}`);
    }
    return {
      filePath,
      content: await response.text()
    };
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
      throw new Error(body.description ? `Telegram API ${method} returned ok=false: ${body.description}` : `Telegram API ${method} returned ok=false`);
    }

    return body.result;
  }
}
