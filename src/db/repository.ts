import type {
  CategoryRecord,
  DraftPayload,
  EntryRecord,
  EntryType,
  ReportCategorySummary,
  ReportSubcategorySummary,
  SubcategoryRecord,
  UiSession,
  UserRecord
} from "@/domain/types";
import { splitNowForUser } from "@/utils/dates";
import { normalizeName } from "@/utils/normalize";

type D1Value = string | number | null;

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

  async getHomeStats(userId: number): Promise<{
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

    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
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
      .bind(userId, `${month}%`)
      .first<{ income: number; expense: number }>();

    const lastEntry = await this.getEntryList(userId, 0, 1).then((items) => items[0] ?? null);

    return {
      totalEntries: count?.count ?? 0,
      todayIncome: todayStats?.income ?? 0,
      todayExpense: todayStats?.expense ?? 0,
      monthIncome: monthStats?.income ?? 0,
      monthExpense: monthStats?.expense ?? 0,
      lastEntry
    };
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

  async listCategories(userId: number, type: EntryType, hidden = false, page = 0, limit = 6): Promise<CategoryRecord[]> {
    const result = await this.db
      .prepare(
        `
        SELECT *
        FROM categories
        WHERE user_id = ? AND type = ? AND ${hidden ? "hidden_at IS NOT NULL" : "hidden_at IS NULL"}
        ORDER BY usage_count_cache DESC, updated_at DESC, id DESC
        LIMIT ? OFFSET ?
      `
      )
      .bind(userId, type, limit, page * limit)
      .all<Record<string, D1Value>>();
    return (result.results ?? []).map(mapCategory);
  }

  async resetUserSettings(userId: number): Promise<void> {
    await this.db
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
      .bind(userId)
      .run();
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

  async getSubcategories(userId: number, categoryId: number): Promise<SubcategoryRecord[]> {
    const rows = await this.db
      .prepare(
        `
        SELECT *
        FROM subcategories
        WHERE user_id = ? AND category_id = ?
        ORDER BY usage_count_cache DESC, updated_at DESC, id DESC
      `
      )
      .bind(userId, categoryId)
      .all<Record<string, D1Value>>();
    return (rows.results ?? []).map(mapSubcategory);
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

  async hideCategory(userId: number, categoryId: number): Promise<void> {
    await this.db.prepare("UPDATE categories SET hidden_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?").bind(userId, categoryId).run();
  }

  async restoreCategory(userId: number, categoryId: number): Promise<void> {
    await this.db.prepare("UPDATE categories SET hidden_at = NULL WHERE user_id = ? AND id = ?").bind(userId, categoryId).run();
  }

  async createCronRun(jobName: string, status: string, summary: string): Promise<void> {
    await this.db.prepare("INSERT INTO cron_runs (job_name, status, summary) VALUES (?, ?, ?)").bind(jobName, status, summary).run();
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

  async updateUserFields(userId: number, updates: Record<string, string | number | null>): Promise<void> {
    const entries = Object.entries(updates);
    if (entries.length === 0) {
      return;
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

  async exportEntriesSnapshot(userId: number): Promise<Record<string, unknown>> {
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
      .all();

    return {
      exported_at: new Date().toISOString(),
      entries: entries.results ?? []
    };
  }

  async clearAllUserData(userId: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM entries WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM subcategories WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM categories WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM drafts WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM intake_queue WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM ui_sessions WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM saved_views WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM imports WHERE user_id = ?").bind(userId),
      this.db.prepare("UPDATE users SET onboarding_step = 0, onboarding_completed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(userId)
    ]);
  }
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
    usageCountCache: Number(row.usage_count_cache)
  };
}

function mapSubcategory(row: Record<string, D1Value>): SubcategoryRecord {
  return {
    id: Number(row.id),
    categoryId: Number(row.category_id),
    name: String(row.name),
    hiddenAt: row.hidden_at ? String(row.hidden_at) : null,
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
