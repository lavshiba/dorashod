import type {
  CategoryRecord,
  DraftPayload,
  EntryRecord,
  EntryType,
  ImportRecord,
  ReportCategorySummary,
  ReportSubcategorySummary,
  SubcategoryRecord,
  UiSession,
  UserRecord
} from "@/domain/types";
import { splitNowForUser } from "@/utils/dates";
import { normalizeName } from "@/utils/normalize";

type D1Value = string | number | null;
type UserUpdatableField =
  | "currency_code"
  | "currency_label"
  | "quick_access_mode_expense"
  | "quick_access_mode_income"
  | "quick_access_mode_subcategories"
  | "sort_mode_expense"
  | "sort_mode_income"
  | "sort_mode_subcategories"
  | "subcategories_enabled"
  | "timezone_name"
  | "timezone_source";

const USER_UPDATABLE_FIELDS = new Set<UserUpdatableField>([
  "currency_code",
  "currency_label",
  "quick_access_mode_expense",
  "quick_access_mode_income",
  "quick_access_mode_subcategories",
  "sort_mode_expense",
  "sort_mode_income",
  "sort_mode_subcategories",
  "subcategories_enabled",
  "timezone_name",
  "timezone_source"
]);

type CategoryTransferRow = {
  id: number;
  subcategoryNormalizedName: string | null;
};

type EntriesExportRow = {
  date: string | null;
  time: string | null;
  amountMinor: number;
  type: EntryType;
  category: string;
  subcategory: string | null;
  description: string | null;
};

export type CategoryTransferPlan = {
  updates: Array<{ entryId: number; targetSubcategoryId: number | null }>;
  movedCount: number;
  clearedSubcategoryCount: number;
};

export function resolveSubcategorySortMode(sortModeOverride: string | null, fallback: string): string {
  return sortModeOverride && ["usage", "recent", "alphabet"].includes(sortModeOverride) ? sortModeOverride : fallback;
}

function json<T>(value: T): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export class Repository {
  constructor(private readonly db: D1Database) {}

  async healthCheck(): Promise<boolean> {
    const result = await this.db.prepare("SELECT 1 as ok").first<{ ok: number }>();
    return result?.ok === 1;
  }

  async getOrCreateUser(telegramUserId: string, chatId: string): Promise<UserRecord> {
    const existing = await this.db
      .prepare(
        `
        SELECT *
        FROM users
        WHERE telegram_user_id = ?
      `
      )
      .bind(telegramUserId)
      .first<Record<string, D1Value>>();

    if (existing) {
      if (existing.chat_id !== chatId) {
        await this.db.prepare("UPDATE users SET chat_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(chatId, existing.id).run();
      }
      return mapUser(existing);
    }

    await this.db
      .prepare("INSERT INTO users (telegram_user_id, chat_id) VALUES (?, ?)")
      .bind(telegramUserId, chatId)
      .run();

    const created = await this.db
      .prepare("SELECT * FROM users WHERE telegram_user_id = ?")
      .bind(telegramUserId)
      .first<Record<string, D1Value>>();

    if (!created) {
      throw new Error("Failed to create user");
    }

    return mapUser(created);
  }

  async completeOnboarding(userId: number): Promise<void> {
    await this.db
      .prepare("UPDATE users SET onboarding_step = 7, onboarding_completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(userId)
      .run();
  }

  async setOnboardingStep(userId: number, step: number): Promise<void> {
    await this.db
      .prepare("UPDATE users SET onboarding_step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(step, userId)
      .run();
  }

  async getSession(userId: number): Promise<UiSession> {
    const row = await this.db
      .prepare("SELECT * FROM ui_sessions WHERE user_id = ?")
      .bind(userId)
      .first<Record<string, D1Value>>();

    if (!row) {
      return { mode: "idle", stack: [], context: {} };
    }

    return {
      mode: String(row.mode) as UiSession["mode"],
      stack: parseJson<string[]>(String(row.stack_json)),
      context: parseJson<Record<string, unknown>>(String(row.context_json))
    };
  }

  async saveSession(userId: number, session: UiSession): Promise<void> {
    await this.db
      .prepare(
        `
        INSERT INTO ui_sessions (user_id, mode, stack_json, context_json, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          mode = excluded.mode,
          stack_json = excluded.stack_json,
          context_json = excluded.context_json,
          updated_at = CURRENT_TIMESTAMP
      `
      )
      .bind(userId, session.mode, json(session.stack), json(session.context))
      .run();
  }

  async clearSession(userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM ui_sessions WHERE user_id = ?").bind(userId).run();
  }

  async getBotSetting(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM bot_settings WHERE key = ?")
      .bind(key)
      .first<Record<string, D1Value>>();
    return row ? String(row.value) : null;
  }

  async setBotSetting(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        `
        INSERT INTO bot_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
      `
      )
      .bind(key, value)
      .run();
  }

  async tryAcquireCallbackLock(userId: number, messageId: number, callbackData: string): Promise<boolean> {
    await this.db
      .prepare(
        `
        DELETE FROM callback_locks
        WHERE user_id = ?
          AND created_at < datetime('now', '-3 seconds')
      `
      )
      .bind(userId)
      .run();

    const result = await this.db
      .prepare(
        `
        INSERT OR IGNORE INTO callback_locks (user_id, message_id, callback_data)
        VALUES (?, ?, ?)
      `
      )
      .bind(userId, messageId, callbackData)
      .run();

    return Number(result.meta.changes ?? 0) > 0;
  }

  async tryAcquireUserUpdateLock(userId: number, lockToken: string): Promise<boolean> {
    await this.db
      .prepare(
        `
        DELETE FROM user_update_locks
        WHERE user_id = ?
          AND created_at < datetime('now', '-15 seconds')
      `
      )
      .bind(userId)
      .run();

    const result = await this.db
      .prepare(
        `
        INSERT OR IGNORE INTO user_update_locks (user_id, lock_token)
        VALUES (?, ?)
      `
      )
      .bind(userId, lockToken)
      .run();

    return Number(result.meta.changes ?? 0) > 0;
  }

  async releaseUserUpdateLock(userId: number, lockToken: string): Promise<void> {
    await this.db
      .prepare(
        `
        DELETE FROM user_update_locks
        WHERE user_id = ?
          AND lock_token = ?
      `
      )
      .bind(userId, lockToken)
      .run();
  }

  async saveDraft(userId: number, payload: DraftPayload, step: string): Promise<void> {
    await this.db
      .prepare(
        `
        INSERT INTO drafts (user_id, payload_json, current_step, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          current_step = excluded.current_step,
          updated_at = CURRENT_TIMESTAMP
      `
      )
      .bind(userId, json(payload), step)
      .run();
  }

  async getDraft(userId: number): Promise<{ payload: DraftPayload; step: string } | null> {
    const row = await this.db
      .prepare("SELECT payload_json, current_step FROM drafts WHERE user_id = ?")
      .bind(userId)
      .first<Record<string, D1Value>>();
    if (!row) {
      return null;
    }
    return {
      payload: parseJson<DraftPayload>(String(row.payload_json)),
      step: String(row.current_step)
    };
  }

  async deleteDraft(userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM drafts WHERE user_id = ?").bind(userId).run();
  }

  async enqueueIntake(userId: number, source: string, rawText: string, parsed: unknown, missing: string[]): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO intake_queue (user_id, source, raw_text, parsed_json, missing_fields_json) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(userId, source, rawText, json(parsed), json(missing))
      .run();
  }

  async getQueueCount(userId: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) as count FROM intake_queue WHERE user_id = ? AND status = 'pending'")
      .bind(userId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async getNextQueueItem(userId: number): Promise<{
    id: number;
    rawText: string;
    parsed: Record<string, unknown>;
    missing: string[];
  } | null> {
    const row = await this.db
      .prepare(
        `
        SELECT id, raw_text, parsed_json, missing_fields_json
        FROM intake_queue
        WHERE user_id = ? AND status = 'pending'
        ORDER BY id ASC
        LIMIT 1
      `
      )
      .bind(userId)
      .first<Record<string, D1Value>>();
    if (!row) {
      return null;
    }
    return {
      id: Number(row.id),
      rawText: String(row.raw_text),
      parsed: parseJson<Record<string, unknown>>(String(row.parsed_json)),
      missing: parseJson<string[]>(String(row.missing_fields_json))
    };
  }

  async markQueueItem(userId: number, itemId: number, status: "saved" | "skipped"): Promise<void> {
    await this.db
      .prepare("UPDATE intake_queue SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?")
      .bind(status, userId, itemId)
      .run();
  }

  async ensureCategory(userId: number, type: EntryType, name: string): Promise<CategoryRecord> {
    const normalized = normalizeName(name);
    const existing = await this.db
      .prepare(
        `
        SELECT *
        FROM categories
        WHERE user_id = ? AND type = ? AND normalized_name = ?
      `
      )
      .bind(userId, type, normalized)
      .first<Record<string, D1Value>>();

    if (existing) {
      if (existing.hidden_at) {
        await this.db.prepare("UPDATE categories SET hidden_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(existing.id).run();
      }
      return mapCategory(existing);
    }

    await this.db
      .prepare(
        `
        INSERT INTO categories (user_id, type, name, normalized_name)
        VALUES (?, ?, ?, ?)
      `
      )
      .bind(userId, type, name.trim(), normalized)
      .run();

    const row = await this.db
      .prepare("SELECT * FROM categories WHERE user_id = ? AND type = ? AND normalized_name = ?")
      .bind(userId, type, normalized)
      .first<Record<string, D1Value>>();

    if (!row) {
      throw new Error("Failed to create category");
    }

    return mapCategory(row);
  }

  async findCategoryByNormalizedName(userId: number, type: EntryType, name: string): Promise<CategoryRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM categories WHERE user_id = ? AND type = ? AND normalized_name = ?")
      .bind(userId, type, normalizeName(name))
      .first<Record<string, D1Value>>();
    return row ? mapCategory(row) : null;
  }

  async ensureSubcategory(userId: number, categoryId: number, name: string): Promise<SubcategoryRecord> {
    const normalized = normalizeName(name);
    const existing = await this.db
      .prepare(
        `
        SELECT *
        FROM subcategories
        WHERE category_id = ? AND normalized_name = ?
      `
      )
      .bind(categoryId, normalized)
      .first<Record<string, D1Value>>();

    if (existing) {
      if (existing.hidden_at) {
        await this.db.prepare("UPDATE subcategories SET hidden_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(existing.id).run();
      }
      return mapSubcategory(existing);
    }

    await this.db
      .prepare(
        `
        INSERT INTO subcategories (user_id, category_id, name, normalized_name)
        VALUES (?, ?, ?, ?)
      `
      )
      .bind(userId, categoryId, name.trim(), normalized)
      .run();

    const row = await this.db
      .prepare("SELECT * FROM subcategories WHERE category_id = ? AND normalized_name = ?")
      .bind(categoryId, normalized)
      .first<Record<string, D1Value>>();

    if (!row) {
      throw new Error("Failed to create subcategory");
    }

    return mapSubcategory(row);
  }

  async findSubcategoryByNormalizedName(categoryId: number, name: string): Promise<SubcategoryRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM subcategories WHERE category_id = ? AND normalized_name = ?")
      .bind(categoryId, normalizeName(name))
      .first<Record<string, D1Value>>();
    return row ? mapSubcategory(row) : null;
  }

  async createEntry(input: {
    user: UserRecord;
    type: EntryType;
    amountMinor: number;
    categoryName: string;
    subcategoryName?: string;
    description?: string;
    source: string;
    entryDate?: string | null;
    entryTime?: string | null;
    isTimeAuto?: boolean;
    isDateMissing?: boolean;
  }): Promise<void> {
    const category = await this.ensureCategory(input.user.id, input.type, input.categoryName);
    let subcategoryId: number | null = null;

    if (input.subcategoryName && input.user.subcategoriesEnabled) {
      const subcategory = await this.ensureSubcategory(input.user.id, category.id, input.subcategoryName);
      subcategoryId = subcategory.id;
    }

    const fallback = splitNowForUser(input.user.timezoneName);
    const entryDate = input.entryDate ?? fallback.date;
    const entryTime = input.entryTime ?? fallback.time;
    const entryDatetimeSort = input.isDateMissing ? null : `${entryDate}T${entryTime}`;

    await this.db
      .prepare(
        `
        INSERT INTO entries (
          user_id, type, amount_minor, currency_label, category_id, subcategory_id, description,
          entry_date, entry_time, entry_datetime_sort, is_time_auto, is_date_missing, source
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .bind(
        input.user.id,
        input.type,
        input.amountMinor,
        input.user.currencyLabel,
        category.id,
        subcategoryId,
        input.description ?? null,
        entryDate,
        entryTime,
        entryDatetimeSort,
        input.isTimeAuto ? 1 : 0,
        input.isDateMissing ? 1 : 0,
        input.source
      )
      .run();

    await this.db.prepare("UPDATE categories SET usage_count_cache = usage_count_cache + 1 WHERE id = ?").bind(category.id).run();
    if (subcategoryId) {
      await this.db.prepare("UPDATE subcategories SET usage_count_cache = usage_count_cache + 1 WHERE id = ?").bind(subcategoryId).run();
    }
  }

  async createEntriesBulk(
    user: UserRecord,
    entries: Array<{
      type: EntryType;
      amountMinor: number;
      categoryName: string;
      subcategoryName?: string | null;
      description?: string | null;
      source: string;
      entryDate?: string | null;
      entryTime?: string | null;
      isTimeAuto?: boolean;
      isDateMissing?: boolean;
    }>
  ): Promise<void> {
    const fallback = splitNowForUser(user.timezoneName);
    const categoryCache = new Map<string, CategoryRecord>();
    const subcategoryCache = new Map<string, SubcategoryRecord>();
    const chunkSize = 100;

    let statements: D1PreparedStatement[] = [];
    let categoryUsage = new Map<number, number>();
    let subcategoryUsage = new Map<number, number>();

    const flush = async (): Promise<void> => {
      if (statements.length === 0) {
        return;
      }
      for (const [categoryId, count] of categoryUsage) {
        statements.push(this.db.prepare("UPDATE categories SET usage_count_cache = usage_count_cache + ? WHERE id = ?").bind(count, categoryId));
      }
      for (const [subcategoryId, count] of subcategoryUsage) {
        statements.push(this.db.prepare("UPDATE subcategories SET usage_count_cache = usage_count_cache + ? WHERE id = ?").bind(count, subcategoryId));
      }
      await this.db.batch(statements);
      statements = [];
      categoryUsage = new Map<number, number>();
      subcategoryUsage = new Map<number, number>();
    };

    for (const item of entries) {
      const categoryKey = `${item.type}:${normalizeName(item.categoryName)}`;
      let category = categoryCache.get(categoryKey);
      if (!category) {
        category = await this.ensureCategory(user.id, item.type, item.categoryName);
        categoryCache.set(categoryKey, category);
      }

      let subcategoryId: number | null = null;
      if (item.subcategoryName && user.subcategoriesEnabled) {
        const subcategoryKey = `${category.id}:${normalizeName(item.subcategoryName)}`;
        let subcategory = subcategoryCache.get(subcategoryKey);
        if (!subcategory) {
          subcategory = await this.ensureSubcategory(user.id, category.id, item.subcategoryName);
          subcategoryCache.set(subcategoryKey, subcategory);
        }
        subcategoryId = subcategory.id;
      }

      const entryDate = item.entryDate ?? fallback.date;
      const entryTime = item.entryTime ?? fallback.time;
      const entryDatetimeSort = item.isDateMissing ? null : `${entryDate}T${entryTime}`;

      statements.push(
        this.db
          .prepare(
            `
            INSERT INTO entries (
              user_id, type, amount_minor, currency_label, category_id, subcategory_id, description,
              entry_date, entry_time, entry_datetime_sort, is_time_auto, is_date_missing, source
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          )
          .bind(
            user.id,
            item.type,
            item.amountMinor,
            user.currencyLabel,
            category.id,
            subcategoryId,
            item.description ?? null,
            entryDate,
            entryTime,
            entryDatetimeSort,
            item.isTimeAuto ? 1 : 0,
            item.isDateMissing ? 1 : 0,
            item.source
          )
      );

      categoryUsage.set(category.id, (categoryUsage.get(category.id) ?? 0) + 1);
      if (subcategoryId) {
        subcategoryUsage.set(subcategoryId, (subcategoryUsage.get(subcategoryId) ?? 0) + 1);
      }

      if (statements.length >= chunkSize) {
        await flush();
      }
    }

    await flush();
  }

  async getHomeStats(userId: number, today: string, monthPrefix: string): Promise<{
    totalEntries: number;
    todayIncome: number;
    todayExpense: number;
    monthIncome: number;
    monthExpense: number;
    lastEntry: EntryRecord | null;
  }> {
    const count = await this.db
      .prepare("SELECT COUNT(*) as count FROM entries WHERE user_id = ?")
      .bind(userId)
      .first<{ count: number }>();

    const todayStats = await this.db
      .prepare(
        `
        SELECT
          COALESCE(SUM(CASE WHEN type = 'income' THEN amount_minor END), 0) as income,
          COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_minor END), 0) as expense
        FROM entries
        WHERE user_id = ? AND entry_date = ?
      `
      )
      .bind(userId, today)
      .first<{ income: number; expense: number }>();

    const monthStats = await this.db
      .prepare(
        `
        SELECT
          COALESCE(SUM(CASE WHEN type = 'income' THEN amount_minor END), 0) as income,
          COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_minor END), 0) as expense
        FROM entries
        WHERE user_id = ? AND entry_date LIKE ?
      `
      )
      .bind(userId, `${monthPrefix}%`)
      .first<{ income: number; expense: number }>();

    const lastEntryRow = await this.db
      .prepare(
        `
        SELECT
          e.*,
          c.name as category_name,
          s.name as subcategory_name
        FROM entries e
        JOIN categories c ON c.id = e.category_id
        LEFT JOIN subcategories s ON s.id = e.subcategory_id
        WHERE e.user_id = ?
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 1
      `
      )
      .bind(userId)
      .first<Record<string, D1Value>>();
    const lastEntry = lastEntryRow ? mapEntry(lastEntryRow) : null;

    return {
      totalEntries: count?.count ?? 0,
      todayIncome: todayStats?.income ?? 0,
      todayExpense: todayStats?.expense ?? 0,
      monthIncome: monthStats?.income ?? 0,
      monthExpense: monthStats?.expense ?? 0,
      lastEntry
    };
  }

  async getEntryCount(userId: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) as count FROM entries WHERE user_id = ?")
      .bind(userId)
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async getCategoryCount(userId: number, type: EntryType, hidden = false): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) as count FROM categories WHERE user_id = ? AND type = ? AND ${hidden ? "hidden_at IS NOT NULL" : "hidden_at IS NULL"}`)
      .bind(userId, type)
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async getEntryList(userId: number, page: number, limit = 6): Promise<EntryRecord[]> {
    const offset = page * limit;
    const result = await this.db
      .prepare(
        `
        SELECT
          e.*,
          c.name as category_name,
          s.name as subcategory_name
        FROM entries e
        JOIN categories c ON c.id = e.category_id
        LEFT JOIN subcategories s ON s.id = e.subcategory_id
        WHERE e.user_id = ?
        ORDER BY COALESCE(e.entry_datetime_sort, e.created_at) DESC, e.id DESC
        LIMIT ? OFFSET ?
      `
      )
      .bind(userId, limit, offset)
      .all<Record<string, D1Value>>();

    return (result.results ?? []).map(mapEntry);
  }

  async getEntriesByDateRange(input: {
    userId: number;
    page: number;
    limit?: number;
    from?: string | null;
    to?: string | null;
    type?: EntryType;
    categoryId?: number;
    subcategoryId?: number;
  }): Promise<{ total: number; items: EntryRecord[] }> {
    const limit = input.limit ?? 6;
    const offset = input.page * limit;

    const clauses = ["e.user_id = ?", "e.is_date_missing = 0"];
    const binds: Array<string | number> = [input.userId];

    if (input.type) {
      clauses.push("e.type = ?");
      binds.push(input.type);
    }
    if (typeof input.categoryId === "number") {
      clauses.push("e.category_id = ?");
      binds.push(input.categoryId);
    }
    if (typeof input.subcategoryId === "number") {
      clauses.push("e.subcategory_id = ?");
      binds.push(input.subcategoryId);
    }
    if (input.from) {
      clauses.push("e.entry_date >= ?");
      binds.push(input.from);
    }
    if (input.to) {
      clauses.push("e.entry_date <= ?");
      binds.push(input.to);
    }

    const where = clauses.join(" AND ");
    const total = await this.db
      .prepare(
        `
        SELECT COUNT(*) as count
        FROM entries e
        WHERE ${where}
      `
      )
      .bind(...binds)
      .first<{ count: number }>();

    const rows = await this.db
      .prepare(
        `
        SELECT
          e.*,
          c.name as category_name,
          s.name as subcategory_name
        FROM entries e
        JOIN categories c ON c.id = e.category_id
        LEFT JOIN subcategories s ON s.id = e.subcategory_id
        WHERE ${where}
        ORDER BY COALESCE(e.entry_datetime_sort, e.created_at) DESC, e.id DESC
        LIMIT ? OFFSET ?
      `
      )
      .bind(...binds, limit, offset)
      .all<Record<string, D1Value>>();

    return {
      total: total?.count ?? 0,
      items: (rows.results ?? []).map(mapEntry)
    };
  }

  async getEntryById(userId: number, entryId: number): Promise<EntryRecord | null> {
    const row = await this.db
      .prepare(
        `
        SELECT
          e.*,
          c.name as category_name,
          s.name as subcategory_name
        FROM entries e
        JOIN categories c ON c.id = e.category_id
        LEFT JOIN subcategories s ON s.id = e.subcategory_id
        WHERE e.user_id = ? AND e.id = ?
      `
      )
      .bind(userId, entryId)
      .first<Record<string, D1Value>>();
    return row ? mapEntry(row) : null;
  }

  async getEntriesByIds(userId: number, entryIds: number[]): Promise<EntryRecord[]> {
    if (entryIds.length === 0) {
      return [];
    }
    const placeholders = entryIds.map(() => "?").join(", ");
    const rows = await this.db
      .prepare(
        `
        SELECT
          e.*,
          c.name as category_name,
          s.name as subcategory_name
        FROM entries e
        JOIN categories c ON c.id = e.category_id
        LEFT JOIN subcategories s ON s.id = e.subcategory_id
        WHERE e.user_id = ? AND e.id IN (${placeholders})
      `
      )
      .bind(userId, ...entryIds)
      .all<Record<string, D1Value>>();

    const mapped = new Map((rows.results ?? []).map((row) => [Number(row.id), mapEntry(row)]));
    return entryIds.map((id) => mapped.get(id)).filter(Boolean) as EntryRecord[];
  }

  async deleteEntry(userId: number, entryId: number): Promise<void> {
    await this.db.prepare("DELETE FROM entries WHERE user_id = ? AND id = ?").bind(userId, entryId).run();
  }

  async deleteEntries(userId: number, entryIds: number[]): Promise<void> {
    if (entryIds.length === 0) {
      return;
    }
    const placeholders = entryIds.map(() => "?").join(", ");
    await this.db
      .prepare(`DELETE FROM entries WHERE user_id = ? AND id IN (${placeholders})`)
      .bind(userId, ...entryIds)
      .run();
  }

  async clearSubcategoryForEntries(userId: number, entryIds: number[]): Promise<void> {
    if (entryIds.length === 0) {
      return;
    }
    const placeholders = entryIds.map(() => "?").join(", ");
    await this.db
      .prepare(
        `
        UPDATE entries
        SET subcategory_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND id IN (${placeholders})
      `
      )
      .bind(userId, ...entryIds)
      .run();
  }

  async moveEntriesToCategory(input: {
    user: UserRecord;
    entryIds: number[];
    type: EntryType;
    categoryName: string;
    subcategoryName?: string;
  }): Promise<void> {
    if (input.entryIds.length === 0) {
      return;
    }

    const category = await this.ensureCategory(input.user.id, input.type, input.categoryName);
    let subcategoryId: number | null = null;
    if (input.subcategoryName && input.user.subcategoriesEnabled) {
      const subcategory = await this.ensureSubcategory(input.user.id, category.id, input.subcategoryName);
      subcategoryId = subcategory.id;
    }

    const placeholders = input.entryIds.map(() => "?").join(", ");
    await this.db
      .prepare(
        `
        UPDATE entries
        SET category_id = ?, subcategory_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND id IN (${placeholders})
      `
      )
      .bind(category.id, subcategoryId, input.user.id, ...input.entryIds)
      .run();
  }

  async transferAllCategoryEntries(
    user: UserRecord,
    sourceCategoryId: number,
    type: EntryType,
    targetCategoryName: string
  ): Promise<{ status: "ok"; movedCount: number; clearedSubcategoryCount: number } | { status: "same" }> {
    const targetCategory = await this.ensureCategory(user.id, type, targetCategoryName);
    if (targetCategory.id === sourceCategoryId) {
      return { status: "same" };
    }

    const [entryRows, targetSubcategoryRows] = await Promise.all([
      this.db
        .prepare(
          `
          SELECT e.id, s.normalized_name as subcategory_normalized_name
          FROM entries e
          LEFT JOIN subcategories s ON s.id = e.subcategory_id
          WHERE e.user_id = ? AND e.category_id = ?
        `
        )
        .bind(user.id, sourceCategoryId)
        .all<Record<string, D1Value>>(),
      this.db
        .prepare("SELECT id, normalized_name FROM subcategories WHERE user_id = ? AND category_id = ? AND hidden_at IS NULL")
        .bind(user.id, targetCategory.id)
        .all<Record<string, D1Value>>()
    ]);

    const targetMap = new Map<string, number>();
    for (const row of targetSubcategoryRows.results ?? []) {
      targetMap.set(String(row.normalized_name), Number(row.id));
    }

    const plan = buildCategoryTransferPlan(
      (entryRows.results ?? []).map((row) => ({
        id: Number(row.id),
        subcategoryNormalizedName: row.subcategory_normalized_name ? String(row.subcategory_normalized_name) : null
      })),
      targetMap
    );

    const statements = plan.updates.map((row) =>
      this.db
        .prepare(
          `
          UPDATE entries
          SET category_id = ?, subcategory_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ? AND id = ?
        `
        )
        .bind(targetCategory.id, row.targetSubcategoryId, user.id, row.entryId)
    );

    if (statements.length > 0) {
      await this.db.batch(statements);
    }

    return {
      status: "ok",
      movedCount: plan.movedCount,
      clearedSubcategoryCount: plan.clearedSubcategoryCount
    };
  }

  async transferAllSubcategoryEntries(userId: number, sourceSubcategoryId: number, targetSubcategoryId: number | null): Promise<void> {
    await this.db
      .prepare(
        `
        UPDATE entries
        SET subcategory_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND subcategory_id = ?
      `
      )
      .bind(targetSubcategoryId, userId, sourceSubcategoryId)
      .run();
  }

  async updateEntry(
    user: UserRecord,
    entryId: number,
    input: {
      type: EntryType;
      amountMinor: number;
      categoryName: string;
      subcategoryName?: string;
      description?: string;
      entryDate?: string | null;
      entryTime?: string | null;
      isTimeAuto?: boolean;
      isDateMissing?: boolean;
    }
  ): Promise<void> {
    const category = await this.ensureCategory(user.id, input.type, input.categoryName);
    let subcategoryId: number | null = null;

    if (input.subcategoryName && user.subcategoriesEnabled) {
      const subcategory = await this.ensureSubcategory(user.id, category.id, input.subcategoryName);
      subcategoryId = subcategory.id;
    }

    const entryDatetimeSort = input.isDateMissing ? null : `${input.entryDate ?? ""}T${input.entryTime ?? ""}`;

    await this.db
      .prepare(
        `
        UPDATE entries
        SET
          type = ?,
          amount_minor = ?,
          currency_label = ?,
          category_id = ?,
          subcategory_id = ?,
          description = ?,
          entry_date = ?,
          entry_time = ?,
          entry_datetime_sort = ?,
          is_time_auto = ?,
          is_date_missing = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND id = ?
      `
      )
      .bind(
        input.type,
        input.amountMinor,
        user.currencyLabel,
        category.id,
        subcategoryId,
        input.description ?? null,
        input.entryDate ?? null,
        input.entryTime ?? null,
        entryDatetimeSort,
        input.isTimeAuto ? 1 : 0,
        input.isDateMissing ? 1 : 0,
        user.id,
        entryId
      )
      .run();
  }

  async searchEntries(userId: number, query: string, page: number, limit = 6): Promise<{ total: number; items: EntryRecord[] }> {
    const token = `%${query.trim().toLowerCase()}%`;
    const total = await this.db
      .prepare(
        `
        SELECT COUNT(*) as count
        FROM entries e
        JOIN categories c ON c.id = e.category_id
        LEFT JOIN subcategories s ON s.id = e.subcategory_id
        WHERE e.user_id = ?
          AND (
            LOWER(c.name) LIKE ?
            OR LOWER(COALESCE(s.name, '')) LIKE ?
            OR LOWER(COALESCE(e.description, '')) LIKE ?
            OR CAST(e.amount_minor / 100.0 AS TEXT) LIKE ?
            OR COALESCE(e.entry_date, '') LIKE ?
          )
      `
      )
      .bind(userId, token, token, token, token, token)
      .first<{ count: number }>();

    const offset = page * limit;
    const rows = await this.db
      .prepare(
        `
        SELECT
          e.*,
          c.name as category_name,
          s.name as subcategory_name
        FROM entries e
        JOIN categories c ON c.id = e.category_id
        LEFT JOIN subcategories s ON s.id = e.subcategory_id
        WHERE e.user_id = ?
          AND (
            LOWER(c.name) LIKE ?
            OR LOWER(COALESCE(s.name, '')) LIKE ?
            OR LOWER(COALESCE(e.description, '')) LIKE ?
            OR CAST(e.amount_minor / 100.0 AS TEXT) LIKE ?
            OR COALESCE(e.entry_date, '') LIKE ?
          )
        ORDER BY COALESCE(e.entry_datetime_sort, e.created_at) DESC, e.id DESC
        LIMIT ? OFFSET ?
      `
      )
      .bind(userId, token, token, token, token, token, limit, offset)
      .all<Record<string, D1Value>>();

    return {
      total: total?.count ?? 0,
      items: (rows.results ?? []).map(mapEntry)
    };
  }

  async getSummaryByDateRange(userId: number, from?: string | null, to?: string | null): Promise<{
    income: number;
    expense: number;
    entries: number;
  }> {
    const clauses = ["user_id = ?", "is_date_missing = 0"];
    const binds: Array<string | number> = [userId];
    if (from) {
      clauses.push("entry_date >= ?");
      binds.push(from);
    }
    if (to) {
      clauses.push("entry_date <= ?");
      binds.push(to);
    }

    const row = await this.db
      .prepare(
        `
        SELECT
          COALESCE(SUM(CASE WHEN type = 'income' THEN amount_minor END), 0) as income,
          COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_minor END), 0) as expense,
          COUNT(*) as entries
        FROM entries
        WHERE ${clauses.join(" AND ")}
      `
      )
      .bind(...binds)
      .first<{ income: number; expense: number; entries: number }>();

    return {
      income: row?.income ?? 0,
      expense: row?.expense ?? 0,
      entries: row?.entries ?? 0
    };
  }

  async getCategoryBreakdownByDateRange(input: {
    userId: number;
    type: EntryType;
    page: number;
    limit?: number;
    from?: string | null;
    to?: string | null;
  }): Promise<{ total: number; items: ReportCategorySummary[] }> {
    const limit = input.limit ?? 4;
    const offset = input.page * limit;
    const clauses = ["e.user_id = ?", "e.type = ?", "e.is_date_missing = 0"];
    const binds: Array<string | number> = [input.userId, input.type];

    if (input.from) {
      clauses.push("e.entry_date >= ?");
      binds.push(input.from);
    }
    if (input.to) {
      clauses.push("e.entry_date <= ?");
      binds.push(input.to);
    }

    const where = clauses.join(" AND ");
    const groupedSql = `
      FROM entries e
      JOIN categories c ON c.id = e.category_id
      WHERE ${where}
      GROUP BY c.id, c.name
    `;

    const total = await this.db
      .prepare(`SELECT COUNT(*) as count FROM (SELECT c.id ${groupedSql}) grouped`)
      .bind(...binds)
      .first<{ count: number }>();

    const rows = await this.db
      .prepare(
        `
        SELECT
          c.id as category_id,
          c.name as category_name,
          SUM(e.amount_minor) as amount_minor,
          COUNT(*) as entries
        ${groupedSql}
        ORDER BY amount_minor DESC, entries DESC, category_name ASC
        LIMIT ? OFFSET ?
      `
      )
      .bind(...binds, limit, offset)
      .all<Record<string, D1Value>>();

    return {
      total: total?.count ?? 0,
      items: (rows.results ?? []).map((row) => ({
        categoryId: Number(row.category_id),
        categoryName: String(row.category_name),
        amountMinor: Number(row.amount_minor),
        entries: Number(row.entries)
      }))
    };
  }

  async getCategoryReportCard(input: {
    userId: number;
    categoryId: number;
    type: EntryType;
    from?: string | null;
    to?: string | null;
  }): Promise<{
    category: CategoryRecord | null;
    amountMinor: number;
    entries: number;
    totalByType: number;
    subcategories: ReportSubcategorySummary[];
  }> {
    const category = await this.getCategory(input.userId, input.categoryId);
    if (!category) {
      return {
        category: null,
        amountMinor: 0,
        entries: 0,
        totalByType: 0,
        subcategories: []
      };
    }

    const clauses = ["e.user_id = ?", "e.type = ?", "e.is_date_missing = 0"];
    const binds: Array<string | number> = [input.userId, input.type];
    if (input.from) {
      clauses.push("e.entry_date >= ?");
      binds.push(input.from);
    }
    if (input.to) {
      clauses.push("e.entry_date <= ?");
      binds.push(input.to);
    }

    const typeWhere = clauses.join(" AND ");
    const row = await this.db
      .prepare(
        `
        SELECT
          COALESCE(SUM(CASE WHEN e.category_id = ? THEN e.amount_minor END), 0) as amount_minor,
          COALESCE(SUM(e.amount_minor), 0) as total_by_type,
          COALESCE(SUM(CASE WHEN e.category_id = ? THEN 1 ELSE 0 END), 0) as entries
        FROM entries e
        WHERE ${typeWhere}
      `
      )
      .bind(input.categoryId, input.categoryId, ...binds)
      .first<{ amount_minor: number; total_by_type: number; entries: number }>();

    const subcategoryClauses = [...clauses, "e.category_id = ?", "e.subcategory_id IS NOT NULL"];
    const subcategoryBinds = [...binds, input.categoryId];
    const subcategoryRows = await this.db
      .prepare(
        `
        SELECT
          s.id as subcategory_id,
          s.name as subcategory_name,
          SUM(e.amount_minor) as amount_minor,
          COUNT(*) as entries
        FROM entries e
        JOIN subcategories s ON s.id = e.subcategory_id
        WHERE ${subcategoryClauses.join(" AND ")}
        GROUP BY s.id, s.name
        ORDER BY amount_minor DESC, entries DESC, subcategory_name ASC
      `
      )
      .bind(...subcategoryBinds)
      .all<Record<string, D1Value>>();

    return {
      category,
      amountMinor: row?.amount_minor ?? 0,
      entries: row?.entries ?? 0,
      totalByType: row?.total_by_type ?? 0,
      subcategories: (subcategoryRows.results ?? []).map((item) => ({
        subcategoryId: Number(item.subcategory_id),
        subcategoryName: String(item.subcategory_name),
        amountMinor: Number(item.amount_minor),
        entries: Number(item.entries)
      }))
    };
  }

  async getSubcategoryReportCard(input: {
    userId: number;
    categoryId: number;
    subcategoryId: number;
    type: EntryType;
    from?: string | null;
    to?: string | null;
  }): Promise<{
    category: CategoryRecord | null;
    subcategory: SubcategoryRecord | null;
    amountMinor: number;
    entries: number;
    totalInCategory: number;
  }> {
    const [category] = await Promise.all([this.getCategory(input.userId, input.categoryId)]);
    if (!category) {
      return {
        category: null,
        subcategory: null,
        amountMinor: 0,
        entries: 0,
        totalInCategory: 0
      };
    }

    const subcategoryRow = await this.db
      .prepare("SELECT * FROM subcategories WHERE user_id = ? AND id = ? AND category_id = ?")
      .bind(input.userId, input.subcategoryId, input.categoryId)
      .first<Record<string, D1Value>>();
    const subcategory = subcategoryRow ? mapSubcategory(subcategoryRow) : null;
    if (!subcategory) {
      return {
        category,
        subcategory: null,
        amountMinor: 0,
        entries: 0,
        totalInCategory: 0
      };
    }

    const clauses = ["user_id = ?", "type = ?", "is_date_missing = 0"];
    const binds: Array<string | number> = [input.userId, input.type];
    if (input.from) {
      clauses.push("entry_date >= ?");
      binds.push(input.from);
    }
    if (input.to) {
      clauses.push("entry_date <= ?");
      binds.push(input.to);
    }

    const row = await this.db
      .prepare(
        `
        SELECT
          COALESCE(SUM(CASE WHEN category_id = ? AND subcategory_id = ? THEN amount_minor END), 0) as amount_minor,
          COALESCE(SUM(CASE WHEN category_id = ? AND subcategory_id = ? THEN 1 ELSE 0 END), 0) as entries,
          COALESCE(SUM(CASE WHEN category_id = ? THEN amount_minor END), 0) as total_in_category
        FROM entries
        WHERE ${clauses.join(" AND ")}
      `
      )
      .bind(input.categoryId, input.subcategoryId, input.categoryId, input.subcategoryId, input.categoryId, ...binds)
      .first<{ amount_minor: number; entries: number; total_in_category: number }>();

    return {
      category,
      subcategory,
      amountMinor: row?.amount_minor ?? 0,
      entries: row?.entries ?? 0,
      totalInCategory: row?.total_in_category ?? 0
    };
  }

  async listCategories(userId: number, type: EntryType, hidden = false, page = 0, limit = 6, sortMode = "usage"): Promise<CategoryRecord[]> {
    const orderBy =
      sortMode === "recent"
        ? "updated_at DESC, id DESC"
        : sortMode === "alphabet"
          ? "name COLLATE NOCASE ASC, id DESC"
          : "usage_count_cache DESC, updated_at DESC, id DESC";
    const result = await this.db
      .prepare(
        `
        SELECT *
        FROM categories
        WHERE user_id = ? AND type = ? AND ${hidden ? "hidden_at IS NOT NULL" : "hidden_at IS NULL"}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `
      )
      .bind(userId, type, limit, page * limit)
      .all<Record<string, D1Value>>();
    return (result.results ?? []).map(mapCategory);
  }

  async listQuickAccessCategories(userId: number, type: EntryType): Promise<CategoryRecord[]> {
    const rows = await this.db
      .prepare(
        `
        SELECT *
        FROM categories
        WHERE user_id = ? AND type = ? AND hidden_at IS NULL AND quick_access_slot IS NOT NULL
        ORDER BY quick_access_slot ASC, id ASC
      `
      )
      .bind(userId, type)
      .all<Record<string, D1Value>>();
    return (rows.results ?? []).map(mapCategory);
  }

  async updateCategoryQuickAccessSlots(userId: number, type: EntryType, categoryIds: number[]): Promise<void> {
    const statements = [
      this.db.prepare("UPDATE categories SET quick_access_slot = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND type = ?").bind(userId, type)
    ];
    for (const [index, categoryId] of categoryIds.slice(0, 4).entries()) {
      statements.push(
        this.db
          .prepare("UPDATE categories SET quick_access_slot = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND type = ? AND id = ?")
          .bind(index + 1, userId, type, categoryId)
      );
    }
    await this.db.batch(statements);
  }

  async resetUserSettings(userId: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `
          UPDATE users
          SET
            currency_code = 'RUB',
            currency_label = '₽',
            timezone_name = 'Europe/Moscow',
            timezone_source = 'default',
            subcategories_enabled = 1,
            quick_access_mode_expense = 'automatically',
            quick_access_mode_income = 'automatically',
            quick_access_mode_subcategories = 'automatically',
            sort_mode_expense = 'usage',
            sort_mode_income = 'usage',
            sort_mode_subcategories = 'usage',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `
        )
        .bind(userId),
      this.db.prepare("UPDATE categories SET sort_mode_override = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?").bind(userId)
    ]);
  }

  async getHiddenCategoryCount(userId: number, type: EntryType): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) as count FROM categories WHERE user_id = ? AND type = ? AND hidden_at IS NOT NULL")
      .bind(userId, type)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async getCategory(userId: number, categoryId: number): Promise<CategoryRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM categories WHERE user_id = ? AND id = ?")
      .bind(userId, categoryId)
      .first<Record<string, D1Value>>();
    return row ? mapCategory(row) : null;
  }

  async getSubcategories(userId: number, categoryId: number, sortMode = "usage"): Promise<SubcategoryRecord[]> {
    const effectiveSortMode = resolveSubcategorySortMode((await this.getCategory(userId, categoryId))?.sortModeOverride ?? null, sortMode);
    const orderBy =
      effectiveSortMode === "recent"
        ? "updated_at DESC, id DESC"
        : effectiveSortMode === "alphabet"
          ? "name COLLATE NOCASE ASC, id DESC"
          : "usage_count_cache DESC, updated_at DESC, id DESC";
    const rows = await this.db
      .prepare(
        `
        SELECT *
        FROM subcategories
        WHERE user_id = ? AND category_id = ? AND hidden_at IS NULL
        ORDER BY ${orderBy}
      `
      )
      .bind(userId, categoryId)
      .all<Record<string, D1Value>>();
    return (rows.results ?? []).map(mapSubcategory);
  }

  async listQuickAccessSubcategories(userId: number, categoryId: number): Promise<SubcategoryRecord[]> {
    const rows = await this.db
      .prepare(
        `
        SELECT *
        FROM subcategories
        WHERE user_id = ? AND category_id = ? AND hidden_at IS NULL AND quick_access_slot IS NOT NULL
        ORDER BY quick_access_slot ASC, id ASC
      `
      )
      .bind(userId, categoryId)
      .all<Record<string, D1Value>>();
    return (rows.results ?? []).map(mapSubcategory);
  }

  async updateSubcategoryQuickAccessSlots(userId: number, categoryId: number, subcategoryIds: number[]): Promise<void> {
    const statements = [
      this.db
        .prepare("UPDATE subcategories SET quick_access_slot = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND category_id = ?")
        .bind(userId, categoryId)
    ];
    for (const [index, subcategoryId] of subcategoryIds.slice(0, 4).entries()) {
      statements.push(
        this.db
          .prepare("UPDATE subcategories SET quick_access_slot = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND category_id = ? AND id = ?")
          .bind(index + 1, userId, categoryId, subcategoryId)
      );
    }
    await this.db.batch(statements);
  }

  async getSubcategory(userId: number, subcategoryId: number): Promise<SubcategoryRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM subcategories WHERE user_id = ? AND id = ?")
      .bind(userId, subcategoryId)
      .first<Record<string, D1Value>>();
    return row ? mapSubcategory(row) : null;
  }

  async getSubcategoryCount(userId: number, categoryId: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) as count FROM subcategories WHERE user_id = ? AND category_id = ? AND hidden_at IS NULL")
      .bind(userId, categoryId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async getCategoryUsageCount(categoryId: number): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) as count FROM entries WHERE category_id = ?").bind(categoryId).first<{ count: number }>();
    return row?.count ?? 0;
  }

  async getSubcategoryUsageCount(subcategoryId: number): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) as count FROM entries WHERE subcategory_id = ?").bind(subcategoryId).first<{ count: number }>();
    return row?.count ?? 0;
  }

  async getHiddenSubcategoryCount(userId: number, categoryId: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) as count FROM subcategories WHERE user_id = ? AND category_id = ? AND hidden_at IS NOT NULL")
      .bind(userId, categoryId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async listHiddenSubcategories(userId: number, categoryId: number, sortMode = "usage"): Promise<SubcategoryRecord[]> {
    const effectiveSortMode = resolveSubcategorySortMode((await this.getCategory(userId, categoryId))?.sortModeOverride ?? null, sortMode);
    const orderBy =
      effectiveSortMode === "recent"
        ? "updated_at DESC, id DESC"
        : effectiveSortMode === "alphabet"
          ? "name COLLATE NOCASE ASC, id DESC"
          : "usage_count_cache DESC, updated_at DESC, id DESC";
    const rows = await this.db
      .prepare(
        `
        SELECT *
        FROM subcategories
        WHERE user_id = ? AND category_id = ? AND hidden_at IS NOT NULL
        ORDER BY ${orderBy}
      `
      )
      .bind(userId, categoryId)
      .all<Record<string, D1Value>>();
    return (rows.results ?? []).map(mapSubcategory);
  }

  async hideCategory(userId: number, categoryId: number): Promise<void> {
    await this.db.prepare("UPDATE categories SET hidden_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?").bind(userId, categoryId).run();
  }

  async restoreCategory(userId: number, categoryId: number): Promise<void> {
    await this.db.prepare("UPDATE categories SET hidden_at = NULL WHERE user_id = ? AND id = ?").bind(userId, categoryId).run();
  }

  async hideSubcategory(userId: number, subcategoryId: number): Promise<void> {
    await this.db.prepare("UPDATE subcategories SET hidden_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?").bind(userId, subcategoryId).run();
  }

  async restoreSubcategory(userId: number, subcategoryId: number): Promise<void> {
    await this.db.prepare("UPDATE subcategories SET hidden_at = NULL WHERE user_id = ? AND id = ?").bind(userId, subcategoryId).run();
  }

  async deleteCategory(userId: number, categoryId: number): Promise<void> {
    await this.db.prepare("DELETE FROM categories WHERE user_id = ? AND id = ?").bind(userId, categoryId).run();
  }

  async deleteSubcategory(userId: number, subcategoryId: number): Promise<void> {
    await this.db.prepare("DELETE FROM subcategories WHERE user_id = ? AND id = ?").bind(userId, subcategoryId).run();
  }

  async renameCategory(userId: number, categoryId: number, name: string): Promise<void> {
    await this.db
      .prepare("UPDATE categories SET name = ?, normalized_name = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?")
      .bind(name.trim(), normalizeName(name), userId, categoryId)
      .run();
  }

  async renameSubcategory(userId: number, subcategoryId: number, name: string): Promise<void> {
    await this.db
      .prepare("UPDATE subcategories SET name = ?, normalized_name = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?")
      .bind(name.trim(), normalizeName(name), userId, subcategoryId)
      .run();
  }

  async createCronRun(jobName: string, status: string, summary: string): Promise<void> {
    await this.db.prepare("INSERT INTO cron_runs (job_name, status, summary) VALUES (?, ?, ?)").bind(jobName, status, summary).run();
  }

  async runCronHousekeeping(): Promise<{
    expiredCallbackLocks: number;
    expiredUserUpdateLocks: number;
    staleImports: number;
    staleCronRuns: number;
  }> {
    const [expiredCallbackLocks, expiredUserUpdateLocks, staleImports, staleCronRuns] = await this.db.batch([
      this.db.prepare("DELETE FROM callback_locks WHERE created_at < datetime('now', '-1 day')"),
      this.db.prepare("DELETE FROM user_update_locks WHERE created_at < datetime('now', '-1 day')"),
      this.db.prepare("DELETE FROM imports WHERE updated_at < datetime('now', '-7 days')"),
      this.db.prepare("DELETE FROM cron_runs WHERE created_at < datetime('now', '-30 days')")
    ]);

    return {
      expiredCallbackLocks: Number(expiredCallbackLocks.meta.changes ?? 0),
      expiredUserUpdateLocks: Number(expiredUserUpdateLocks.meta.changes ?? 0),
      staleImports: Number(staleImports.meta.changes ?? 0),
      staleCronRuns: Number(staleCronRuns.meta.changes ?? 0)
    };
  }

  async updateCategorySortModeOverride(userId: number, categoryId: number, mode: string | null): Promise<void> {
    await this.db
      .prepare("UPDATE categories SET sort_mode_override = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?")
      .bind(mode, userId, categoryId)
      .run();
  }

  async getDiagnostics(): Promise<Record<string, unknown>> {
    const users = await this.db.prepare("SELECT COUNT(*) as count FROM users").first<{ count: number }>();
    const entries = await this.db.prepare("SELECT COUNT(*) as count FROM entries").first<{ count: number }>();
    const queue = await this.db.prepare("SELECT COUNT(*) as count FROM intake_queue WHERE status = 'pending'").first<{ count: number }>();
    const drafts = await this.db.prepare("SELECT COUNT(*) as count FROM drafts").first<{ count: number }>();
    const lastCron = await this.db.prepare("SELECT job_name, status, summary, created_at FROM cron_runs ORDER BY id DESC LIMIT 5").all();

    return {
      users: users?.count ?? 0,
      entries: entries?.count ?? 0,
      queue: queue?.count ?? 0,
      drafts: drafts?.count ?? 0,
      lastCronRuns: lastCron.results ?? []
    };
  }

  async updateUserFields(userId: number, updates: Partial<Record<UserUpdatableField, string | number | null>>): Promise<void> {
    const entries = Object.entries(updates);
    if (entries.length === 0) {
      return;
    }
    for (const [field] of entries) {
      if (!USER_UPDATABLE_FIELDS.has(field as UserUpdatableField)) {
        throw new Error(`Unsupported user field update: ${field}`);
      }
    }
    const setSql = entries.map(([field]) => `${field} = ?`).join(", ");
    const values = entries.map(([, value]) => value);
    await this.db
      .prepare(`UPDATE users SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(...values, userId)
      .run();
  }

  async exportFullUserSnapshot(userId: number): Promise<Record<string, unknown>> {
    const [user, categories, subcategories, entries, draft, queue] = await Promise.all([
      this.db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first(),
      this.db.prepare("SELECT * FROM categories WHERE user_id = ? ORDER BY id").bind(userId).all(),
      this.db.prepare("SELECT * FROM subcategories WHERE user_id = ? ORDER BY id").bind(userId).all(),
      this.db.prepare("SELECT * FROM entries WHERE user_id = ? ORDER BY id").bind(userId).all(),
      this.db.prepare("SELECT * FROM drafts WHERE user_id = ?").bind(userId).first(),
      this.db.prepare("SELECT * FROM intake_queue WHERE user_id = ? ORDER BY id").bind(userId).all()
    ]);

    return {
      exported_at: new Date().toISOString(),
      user,
      categories: categories.results ?? [],
      subcategories: subcategories.results ?? [],
      entries: entries.results ?? [],
      draft,
      intake_queue: queue.results ?? []
    };
  }

  async listEntriesExportRows(userId: number): Promise<EntriesExportRow[]> {
    const entries = await this.db
      .prepare(
        `
        SELECT
          e.entry_date as date,
          e.entry_time as time,
          e.amount_minor as amount_minor,
          e.type,
          c.name as category,
          s.name as subcategory,
          e.description
        FROM entries e
        JOIN categories c ON c.id = e.category_id
        LEFT JOIN subcategories s ON s.id = e.subcategory_id
        WHERE e.user_id = ?
        ORDER BY COALESCE(e.entry_datetime_sort, e.created_at) DESC, e.id DESC
      `
      )
      .bind(userId)
      .all<Record<string, D1Value>>();

    return (entries.results ?? []).map((row) => ({
      date: row.date ? String(row.date) : null,
      time: row.time ? String(row.time) : null,
      amountMinor: Number(row.amount_minor ?? 0),
      type: String(row.type) as EntryType,
      category: String(row.category ?? ""),
      subcategory: row.subcategory ? String(row.subcategory) : null,
      description: row.description ? String(row.description) : null
    }));
  }

  async clearAllUserData(userId: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM callback_locks WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM entries WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM subcategories WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM categories WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM drafts WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM intake_queue WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM ui_sessions WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM saved_views WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM imports WHERE user_id = ?").bind(userId),
      this.db
        .prepare(
          `
          UPDATE users
          SET
            onboarding_step = 0,
            onboarding_completed_at = NULL,
            onboarding_dismissed_at = NULL,
            timezone_name = 'Europe/Moscow',
            timezone_source = 'default',
            currency_code = 'RUB',
            currency_label = '₽',
            subcategories_enabled = 1,
            quick_access_mode_expense = 'automatically',
            quick_access_mode_income = 'automatically',
            quick_access_mode_subcategories = 'automatically',
            sort_mode_expense = 'usage',
            sort_mode_income = 'usage',
            sort_mode_subcategories = 'usage',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `
        )
        .bind(userId)
    ]);
  }

  async createImport(userId: number, importType: string, status: string, preview: Record<string, unknown>): Promise<number> {
    await this.db
      .prepare("INSERT INTO imports (user_id, import_type, status, preview_json) VALUES (?, ?, ?, ?)")
      .bind(userId, importType, status, json(preview))
      .run();

    const row = await this.db
      .prepare("SELECT id FROM imports WHERE user_id = ? ORDER BY id DESC LIMIT 1")
      .bind(userId)
      .first<{ id: number }>();
    if (!row) {
      throw new Error("Failed to create import");
    }
    return row.id;
  }

  async getImport(userId: number, importId: number): Promise<ImportRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM imports WHERE user_id = ? AND id = ?")
      .bind(userId, importId)
      .first<Record<string, D1Value>>();
    return row ? mapImport(row) : null;
  }

  async deleteImport(userId: number, importId: number): Promise<void> {
    await this.db.prepare("DELETE FROM imports WHERE user_id = ? AND id = ?").bind(userId, importId).run();
  }

  async updateImportPreview(userId: number, importId: number, preview: Record<string, unknown>, status = "preview"): Promise<void> {
    await this.db
      .prepare("UPDATE imports SET preview_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?")
      .bind(json(preview), status, userId, importId)
      .run();
  }

  async replaceUserDataFromSnapshot(user: UserRecord, snapshot: Record<string, unknown>): Promise<void> {
    const snapUser = snapshot.user as Record<string, unknown> | null;
    const categories = Array.isArray(snapshot.categories) ? (snapshot.categories as Array<Record<string, unknown>>) : [];
    const subcategories = Array.isArray(snapshot.subcategories) ? (snapshot.subcategories as Array<Record<string, unknown>>) : [];
    const entries = Array.isArray(snapshot.entries) ? (snapshot.entries as Array<Record<string, unknown>>) : [];
    const draft = snapshot.draft as Record<string, unknown> | null;
    const intakeQueue = Array.isArray(snapshot.intake_queue) ? (snapshot.intake_queue as Array<Record<string, unknown>>) : [];

    const statements: D1PreparedStatement[] = [
      this.db.prepare("DELETE FROM callback_locks WHERE user_id = ?").bind(user.id),
      this.db.prepare("DELETE FROM entries WHERE user_id = ?").bind(user.id),
      this.db.prepare("DELETE FROM subcategories WHERE user_id = ?").bind(user.id),
      this.db.prepare("DELETE FROM categories WHERE user_id = ?").bind(user.id),
      this.db.prepare("DELETE FROM drafts WHERE user_id = ?").bind(user.id),
      this.db.prepare("DELETE FROM intake_queue WHERE user_id = ?").bind(user.id),
      this.db.prepare("DELETE FROM ui_sessions WHERE user_id = ?").bind(user.id),
      this.db.prepare("DELETE FROM saved_views WHERE user_id = ?").bind(user.id),
      this.db.prepare("DELETE FROM imports WHERE user_id = ?").bind(user.id)
    ];

    if (snapUser) {
      statements.push(
        this.db
          .prepare(
            `
            UPDATE users
            SET onboarding_step = ?, onboarding_completed_at = ?, timezone_name = ?, timezone_source = ?,
                currency_code = ?, currency_label = ?, subcategories_enabled = ?, quick_access_mode_expense = ?,
                quick_access_mode_income = ?, quick_access_mode_subcategories = ?, sort_mode_expense = ?,
                sort_mode_income = ?, sort_mode_subcategories = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `
          )
          .bind(
            Number(snapUser.onboarding_step ?? 0),
            snapUser.onboarding_completed_at ? String(snapUser.onboarding_completed_at) : null,
            String(snapUser.timezone_name ?? user.timezoneName),
            String(snapUser.timezone_source ?? user.timezoneSource),
            String(snapUser.currency_code ?? user.currencyCode),
            String(snapUser.currency_label ?? user.currencyLabel),
            Number(snapUser.subcategories_enabled ?? (user.subcategoriesEnabled ? 1 : 0)),
            String(snapUser.quick_access_mode_expense ?? user.quickAccessModeExpense),
            String(snapUser.quick_access_mode_income ?? user.quickAccessModeIncome),
            String(snapUser.quick_access_mode_subcategories ?? user.quickAccessModeSubcategories),
            String(snapUser.sort_mode_expense ?? user.sortModeExpense),
            String(snapUser.sort_mode_income ?? user.sortModeIncome),
            String(snapUser.sort_mode_subcategories ?? user.sortModeSubcategories),
            user.id
          )
      );
    }

    for (const item of categories) {
      statements.push(
        this.db
          .prepare(
            `
            INSERT INTO categories (id, user_id, type, name, normalized_name, hidden_at, quick_access_slot, sort_mode_override, usage_count_cache, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          )
          .bind(
            Number(item.id),
            user.id,
            String(item.type),
            String(item.name),
            String(item.normalized_name),
            item.hidden_at ? String(item.hidden_at) : null,
            item.quick_access_slot === null || typeof item.quick_access_slot === "undefined" ? null : Number(item.quick_access_slot),
            item.sort_mode_override ? String(item.sort_mode_override) : null,
            Number(item.usage_count_cache ?? 0),
            String(item.created_at ?? new Date().toISOString()),
            String(item.updated_at ?? new Date().toISOString())
          )
      );
    }

    for (const item of subcategories) {
      statements.push(
        this.db
          .prepare(
            `
            INSERT INTO subcategories (id, user_id, category_id, name, normalized_name, hidden_at, quick_access_slot, usage_count_cache, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          )
          .bind(
            Number(item.id),
            user.id,
            Number(item.category_id),
            String(item.name),
            String(item.normalized_name),
            item.hidden_at ? String(item.hidden_at) : null,
            item.quick_access_slot === null || typeof item.quick_access_slot === "undefined" ? null : Number(item.quick_access_slot),
            Number(item.usage_count_cache ?? 0),
            String(item.created_at ?? new Date().toISOString()),
            String(item.updated_at ?? new Date().toISOString())
          )
      );
    }

    for (const item of entries) {
      statements.push(
        this.db
          .prepare(
            `
            INSERT INTO entries (
              id, user_id, type, amount_minor, currency_label, category_id, subcategory_id, description,
              entry_date, entry_time, entry_datetime_sort, is_time_auto, is_date_missing, source, external_hash, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          )
          .bind(
            Number(item.id),
            user.id,
            String(item.type),
            Number(item.amount_minor),
            String(item.currency_label ?? user.currencyLabel),
            Number(item.category_id),
            item.subcategory_id === null || typeof item.subcategory_id === "undefined" ? null : Number(item.subcategory_id),
            item.description ? String(item.description) : null,
            item.entry_date ? String(item.entry_date) : null,
            item.entry_time ? String(item.entry_time) : null,
            item.entry_datetime_sort ? String(item.entry_datetime_sort) : null,
            Number(item.is_time_auto ?? 0),
            Number(item.is_date_missing ?? 0),
            String(item.source ?? "restore"),
            item.external_hash ? String(item.external_hash) : null,
            String(item.created_at ?? new Date().toISOString()),
            String(item.updated_at ?? new Date().toISOString())
          )
      );
    }

    if (draft) {
      statements.push(
        this.db
          .prepare(
            `
            INSERT INTO drafts (user_id, payload_json, current_step, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
          `
          )
          .bind(
            user.id,
            String(draft.payload_json ?? "{}"),
            String(draft.current_step ?? "amount"),
            String(draft.created_at ?? new Date().toISOString()),
            String(draft.updated_at ?? new Date().toISOString())
          )
      );
    }

    for (const item of intakeQueue) {
      statements.push(
        this.db
          .prepare(
            `
            INSERT INTO intake_queue (id, user_id, source, raw_text, parsed_json, missing_fields_json, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          )
          .bind(
            Number(item.id),
            user.id,
            String(item.source ?? "restore"),
            String(item.raw_text ?? ""),
            String(item.parsed_json ?? "{}"),
            String(item.missing_fields_json ?? "[]"),
            String(item.status ?? "pending"),
            String(item.created_at ?? new Date().toISOString()),
            String(item.updated_at ?? new Date().toISOString())
          )
      );
    }

    await this.db.batch(statements);
  }

  async getExistingEntryDedupKeys(userId: number): Promise<string[]> {
    const rows = await this.db
      .prepare(
        `
        SELECT
          e.type,
          e.amount_minor,
          e.entry_date,
          e.entry_time,
          c.normalized_name as category_name,
          COALESCE(s.normalized_name, '') as subcategory_name,
          LOWER(TRIM(COALESCE(e.description, ''))) as description
        FROM entries e
        JOIN categories c ON c.id = e.category_id
        LEFT JOIN subcategories s ON s.id = e.subcategory_id
        WHERE e.user_id = ?
      `
      )
      .bind(userId)
      .all<Record<string, D1Value>>();

    return (rows.results ?? []).map((row) =>
      [
        String(row.type),
        String(row.amount_minor),
        row.entry_date ? String(row.entry_date) : "",
        row.entry_time ? String(row.entry_time) : "",
        String(row.category_name),
        String(row.subcategory_name),
        String(row.description)
      ].join("|")
    );
  }
}

export function buildCategoryTransferPlan(
  entryRows: CategoryTransferRow[],
  targetMap: Map<string, number>
): CategoryTransferPlan {
  const updates = entryRows.map((row) => {
    const targetSubcategoryId = row.subcategoryNormalizedName ? (targetMap.get(row.subcategoryNormalizedName) ?? null) : null;
    return {
      entryId: row.id,
      targetSubcategoryId
    };
  });

  return {
    updates,
    movedCount: updates.length,
    clearedSubcategoryCount: entryRows.filter((row) => row.subcategoryNormalizedName && !targetMap.has(row.subcategoryNormalizedName)).length
  };
}

function mapUser(row: Record<string, D1Value>): UserRecord {
  return {
    id: Number(row.id),
    telegramUserId: String(row.telegram_user_id),
    chatId: String(row.chat_id),
    onboardingStep: Number(row.onboarding_step),
    onboardingCompletedAt: row.onboarding_completed_at ? String(row.onboarding_completed_at) : null,
    timezoneName: String(row.timezone_name),
    timezoneSource: String(row.timezone_source),
    currencyCode: String(row.currency_code),
    currencyLabel: String(row.currency_label),
    subcategoriesEnabled: Number(row.subcategories_enabled) === 1,
    quickAccessModeExpense: String(row.quick_access_mode_expense),
    quickAccessModeIncome: String(row.quick_access_mode_income),
    quickAccessModeSubcategories: String(row.quick_access_mode_subcategories),
    sortModeExpense: String(row.sort_mode_expense),
    sortModeIncome: String(row.sort_mode_income),
    sortModeSubcategories: String(row.sort_mode_subcategories)
  };
}

function mapCategory(row: Record<string, D1Value>): CategoryRecord {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    type: String(row.type) as EntryType,
    name: String(row.name),
    hiddenAt: row.hidden_at ? String(row.hidden_at) : null,
    quickAccessSlot: row.quick_access_slot === null || typeof row.quick_access_slot === "undefined" ? null : Number(row.quick_access_slot),
    sortModeOverride: row.sort_mode_override ? String(row.sort_mode_override) : null,
    usageCountCache: Number(row.usage_count_cache)
  };
}

function mapSubcategory(row: Record<string, D1Value>): SubcategoryRecord {
  return {
    id: Number(row.id),
    categoryId: Number(row.category_id),
    name: String(row.name),
    hiddenAt: row.hidden_at ? String(row.hidden_at) : null,
    quickAccessSlot: row.quick_access_slot === null || typeof row.quick_access_slot === "undefined" ? null : Number(row.quick_access_slot),
    usageCountCache: Number(row.usage_count_cache)
  };
}

function mapEntry(row: Record<string, D1Value>): EntryRecord {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    type: String(row.type) as EntryType,
    amountMinor: Number(row.amount_minor),
    currencyLabel: String(row.currency_label),
    categoryId: Number(row.category_id),
    categoryName: String(row.category_name),
    subcategoryId: row.subcategory_id === null ? null : Number(row.subcategory_id),
    subcategoryName: row.subcategory_name ? String(row.subcategory_name) : null,
    description: row.description ? String(row.description) : null,
    entryDate: row.entry_date ? String(row.entry_date) : null,
    entryTime: row.entry_time ? String(row.entry_time) : null,
    entryDatetimeSort: row.entry_datetime_sort ? String(row.entry_datetime_sort) : null,
    isTimeAuto: Number(row.is_time_auto) === 1,
    isDateMissing: Number(row.is_date_missing) === 1,
    source: String(row.source),
    createdAt: String(row.created_at)
  };
}

function mapImport(row: Record<string, D1Value>): ImportRecord {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    importType: String(row.import_type),
    status: String(row.status),
    previewJson: parseJson<Record<string, unknown>>(String(row.preview_json)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
