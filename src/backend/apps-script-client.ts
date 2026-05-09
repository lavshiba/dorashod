import type {
  AppsScriptAction,
  AppsScriptBootstrapData,
  AppsScriptRequest,
  AppsScriptResponse
} from "@/backend/contracts";

export class AppsScriptClient {
  constructor(
    private readonly url: string,
    private readonly authToken: string
  ) {}

  async bootstrap(): Promise<AppsScriptBootstrapData> {
    const response = await this.call<AppsScriptBootstrapData>({ action: "bootstrap" });
    return response.data ?? {};
  }

  async income(payload: Record<string, unknown>): Promise<AppsScriptResponse> {
    return this.call({ action: "income", ...payload });
  }

  async expense(payload: Record<string, unknown>): Promise<AppsScriptResponse> {
    return this.call({ action: "expense", ...payload });
  }

  async transfer(payload: Record<string, unknown>): Promise<AppsScriptResponse> {
    return this.call({ action: "transfer", ...payload });
  }

  async creditPayment(payload: Record<string, unknown>): Promise<AppsScriptResponse> {
    return this.call({ action: "credit_payment", ...payload });
  }

  async updateBalance(payload: Record<string, unknown>): Promise<AppsScriptResponse> {
    return this.call({ action: "update_balance", ...payload });
  }

  async createAccount(payload: Record<string, unknown>): Promise<AppsScriptResponse> {
    return this.call({ action: "create_account", ...payload });
  }

  async createCategory(payload: Record<string, unknown>): Promise<AppsScriptResponse> {
    return this.call({ action: "create_category", ...payload });
  }

  async createSubcategory(payload: Record<string, unknown>): Promise<AppsScriptResponse> {
    return this.call({ action: "create_subcategory", ...payload });
  }

  private async call<T = unknown>(payload: AppsScriptRequest): Promise<AppsScriptResponse<T>> {
    this.ensureConfigured();

    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.authToken}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Apps Script request failed with ${response.status}`);
    }

    const body = (await response.json()) as AppsScriptResponse<T>;
    if (!body.ok) {
      throw new Error(body.message || "Apps Script request failed");
    }

    return body;
  }

  private ensureConfigured(): void {
    if (!this.url) {
      throw new Error("Apps Script URL is not configured");
    }
    if (!this.authToken) {
      throw new Error("Apps Script auth token is not configured");
    }
  }
}

export function isAppsScriptAction(value: string): value is AppsScriptAction {
  return [
    "bootstrap",
    "income",
    "expense",
    "transfer",
    "credit_payment",
    "update_balance",
    "create_account",
    "create_category",
    "create_subcategory"
  ].includes(value);
}
