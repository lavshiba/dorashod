export type EntryType = "income" | "expense";

export type UiMode =
  | "idle"
  | "onboarding"
  | "add"
  | "search"
  | "categories"
  | "settings"
  | "data"
  | "reports"
  | "operations"
  | "edit"
  | "queue"
  | "draft"
  | "import";

export interface UserRecord {
  id: number;
  telegramUserId: string;
  chatId: string;
  onboardingStep: number;
  onboardingCompletedAt: string | null;
  timezoneName: string;
  timezoneSource: string;
  currencyCode: string;
  currencyLabel: string;
  subcategoriesEnabled: boolean;
  quickAccessModeExpense: string;
  quickAccessModeIncome: string;
  quickAccessModeSubcategories: string;
  sortModeExpense: string;
  sortModeIncome: string;
  sortModeSubcategories: string;
}

export interface CategoryRecord {
  id: number;
  userId: number;
  type: EntryType;
  name: string;
  hiddenAt: string | null;
  usageCountCache: number;
}

export interface SubcategoryRecord {
  id: number;
  categoryId: number;
  name: string;
  hiddenAt: string | null;
  usageCountCache: number;
}

export interface EntryRecord {
  id: number;
  userId: number;
  type: EntryType;
  amountMinor: number;
  currencyLabel: string;
  categoryId: number;
  categoryName: string;
  subcategoryId: number | null;
  subcategoryName: string | null;
  description: string | null;
  entryDate: string | null;
  entryTime: string | null;
  entryDatetimeSort: string | null;
  isTimeAuto: boolean;
  isDateMissing: boolean;
  source: string;
  createdAt: string;
}

export interface DraftPayload {
  type?: EntryType;
  amountMinor?: number;
  categoryName?: string;
  categoryId?: number;
  subcategoryName?: string;
  subcategoryId?: number;
  description?: string;
  entryDate?: string | null;
  entryTime?: string | null;
  isTimeAuto?: boolean;
  isDateMissing?: boolean;
}

export interface ParsedEntryAttempt {
  type?: EntryType;
  amountMinor?: number;
  category?: string;
  subcategory?: string;
  description?: string;
  lines: string[];
  missing: Array<"type" | "amount" | "category">;
  isBatch: boolean;
}

export interface UiSession {
  mode: UiMode;
  stack: string[];
  context: Record<string, unknown>;
}

export interface TelegramMessagePayload {
  chat_id: string;
  text: string;
  reply_markup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
}

export interface TelegramDocumentPayload {
  chat_id: string;
  filename: string;
  content: string;
  caption?: string;
}
