export type AppsScriptAction =
  | "bootstrap"
  | "income"
  | "expense"
  | "transfer"
  | "credit_payment"
  | "update_balance"
  | "create_account"
  | "create_category"
  | "create_subcategory";

export interface AppsScriptResponse<T = unknown> {
  ok: boolean;
  message: string;
  data?: T;
}

export interface AppsScriptRequest {
  action: AppsScriptAction;
  client_request_id?: string;
  [key: string]: unknown;
}

export interface AppsScriptBootstrapData {
  version?: string;
  account_names?: string[];
  non_credit_account_names?: string[];
  income_expense_account_names?: string[];
  credit_account_names?: string[];
  income_category_names?: string[];
  expense_category_names?: string[];
  categories?: unknown;
  overview?: unknown;
}
