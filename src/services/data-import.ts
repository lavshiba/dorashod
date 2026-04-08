import type { EntryType } from "@/domain/types";
import { parseEntryAttempt } from "@/utils/entry-parser";
import { normalizeName } from "@/utils/normalize";

export type ImportPreviewMeta = {
  format: "csv" | "json" | "unknown";
  totalRows: number;
  validRows: number;
  invalidRows: number;
  recognizedColumns: string[];
  missingRequiredColumns: string[];
  unknownColumns: string[];
};

export type EntriesImportPreview = {
  entries: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
  meta: ImportPreviewMeta;
};

export function parseFullSnapshot(content: string):
  | {
      raw: Record<string, unknown>;
      categories: number;
      expenseCategories: number;
      incomeCategories: number;
      subcategories: number;
      entries: number;
      hasDraft: boolean;
      queue: number;
    }
  | null {
  try {
    const raw = JSON.parse(content) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const summary = summarizeFullSnapshot(raw);
    return {
      raw,
      categories: Array.isArray(raw.categories) ? raw.categories.length : 0,
      expenseCategories: summary.expenseCategories,
      incomeCategories: summary.incomeCategories,
      subcategories: Array.isArray(raw.subcategories) ? raw.subcategories.length : 0,
      entries: summary.entries,
      hasDraft: summary.hasDraft,
      queue: summary.queue
    };
  } catch {
    return null;
  }
}

export function parseEntriesImport(content: string): EntriesImportPreview {
  const jsonParsed = parseEntriesImportJson(content);
  if (jsonParsed) {
    return jsonParsed;
  }

  const csvParsed = parseEntriesImportCsv(content);
  if (csvParsed) {
    return csvParsed;
  }

  return {
    entries: [],
    errors: [{ rawText: "", reason: "файл не удалось прочитать" }],
    meta: {
      format: "unknown",
      totalRows: 0,
      validRows: 0,
      invalidRows: 1,
      recognizedColumns: [],
      missingRequiredColumns: [],
      unknownColumns: []
    }
  };
}

export function stageImportFixPreview(
  preview: {
    entries: Array<Record<string, unknown>>;
    errors: Array<Record<string, unknown>>;
    meta?: Partial<ImportPreviewMeta>;
  },
  index: number
):
  | {
      status: "saved";
      preview: EntriesImportPreview;
    }
  | {
      status: "missing";
      preview: EntriesImportPreview;
    } {
  const errors = [...preview.errors];
  const entries = [...preview.entries];
  const current = errors[index];
  const baseMeta = buildMeta(preview.meta, entries.length, errors.length);

  if (!current) {
    return {
      status: "missing",
      preview: { entries, errors, meta: baseMeta }
    };
  }

  const parsed = parseFixCandidate(String(current.rawText ?? ""));
  if (!(parsed.type && parsed.amountMinor && parsed.category)) {
    return {
      status: "missing",
      preview: { entries, errors, meta: baseMeta }
    };
  }

  entries.push({
    type: parsed.type,
    amountMinor: parsed.amountMinor,
    categoryName: parsed.category,
    subcategoryName: parsed.subcategory ?? null,
    description: parsed.description ?? null,
    entryDate: parsed.entryDate ?? null,
    entryTime: parsed.entryTime ?? null,
    isTimeAuto: parsed.isTimeAuto,
    isDateMissing: parsed.isDateMissing
  });
  errors.splice(index, 1);

  return {
    status: "saved",
    preview: {
      entries,
      errors,
      meta: buildMeta(preview.meta, entries.length, errors.length)
    }
  };
}

export function makeEntryDedupKey(entry: {
  type: EntryType;
  amountMinor: number;
  entryDate: string | null;
  entryTime: string | null;
  categoryName: string;
  subcategoryName: string | null;
  description: string | null;
}): string {
  return [
    entry.type,
    String(entry.amountMinor),
    entry.entryDate ?? "",
    entry.entryTime ?? "",
    normalizeName(entry.categoryName),
    normalizeName(entry.subcategoryName ?? ""),
    normalizeName(String(entry.description ?? ""))
  ].join("|");
}

function summarizeFullSnapshot(raw: Record<string, unknown>): {
  entries: number;
  expenseCategories: number;
  incomeCategories: number;
  hasDraft: boolean;
  queue: number;
} {
  return {
    entries: Array.isArray(raw.entries) ? raw.entries.length : 0,
    expenseCategories: Array.isArray(raw.categories)
      ? raw.categories.filter((item) => typeof item === "object" && item && (item as { type?: unknown }).type === "expense").length
      : 0,
    incomeCategories: Array.isArray(raw.categories)
      ? raw.categories.filter((item) => typeof item === "object" && item && (item as { type?: unknown }).type === "income").length
      : 0,
    hasDraft: Boolean(raw.draft),
    queue: Array.isArray(raw.intake_queue) ? raw.intake_queue.length : 0
  };
}

function parseEntriesImportJson(content: string): EntriesImportPreview | null {
  try {
    const raw = JSON.parse(content) as Record<string, unknown>;
    const items = Array.isArray(raw.entries) ? raw.entries : Array.isArray(raw) ? raw : [];
    const entries: Array<Record<string, unknown>> = [];
    const errors: Array<Record<string, unknown>> = [];

    for (const item of items) {
      const parsed = parseImportedEntry(item as Record<string, unknown>);
      if ("error" in parsed) {
        errors.push({
          rawText: stringifyImportRow(item as Record<string, unknown>),
          reason: parsed.error
        });
      } else {
        entries.push(parsed.entry);
      }
    }

    return {
      entries,
      errors,
      meta: {
        format: "json",
        totalRows: items.length,
        validRows: entries.length,
        invalidRows: errors.length,
        recognizedColumns: [],
        missingRequiredColumns: [],
        unknownColumns: []
      }
    };
  } catch {
    return null;
  }
}

function parseEntriesImportCsv(content: string): EntriesImportPreview | null {
  const lines = content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return null;
  }

  const delimiter = detectCsvDelimiter(lines[0] ?? "");
  const headerCells = splitCsvLine(lines[0] ?? "", delimiter);
  const headerMapping = headerCells.map((header) => normalizeImportHeader(header));
  const recognizedColumns = Array.from(
    new Set(
      headerMapping
        .map((item) => item.canonical)
        .filter((item): item is string => Boolean(item))
    )
  );
  const unknownColumns = headerMapping
    .filter((item) => !item.canonical)
    .map((item) => item.original)
    .filter(Boolean);
  const missingRequiredColumns = getMissingRequiredColumns(recognizedColumns);
  const looksLikeExternalCsv = recognizedColumns.length > 0 || headerCells.length >= 3;

  if (!looksLikeExternalCsv) {
    return null;
  }

  const entries: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];

  if (missingRequiredColumns.length > 0) {
    for (const field of missingRequiredColumns) {
      errors.push({
        rawText: lines[0],
        reason: formatMissingColumnReason(field)
      });
    }

    return {
      entries,
      errors,
      meta: {
        format: "csv",
        totalRows: Math.max(lines.length - 1, 0),
        validRows: 0,
        invalidRows: errors.length,
        recognizedColumns,
        missingRequiredColumns,
        unknownColumns
      }
    };
  }

  const canonicalHeaders = headerMapping.map((item) => item.canonical ?? `unknown:${item.original}`);
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line, delimiter);
    const row: Record<string, unknown> = {};
    canonicalHeaders.forEach((header, index) => {
      if (header.startsWith("unknown:")) {
        return;
      }
      row[header] = normalizeImportValue(cells[index] ?? "");
    });

    const parsed = parseImportedEntry(row);
    if ("error" in parsed) {
      errors.push({
        rawText: line,
        reason: parsed.error
      });
    } else {
      entries.push(parsed.entry);
    }
  }

  return {
    entries,
    errors,
    meta: {
      format: "csv",
      totalRows: Math.max(lines.length - 1, 0),
      validRows: entries.length,
      invalidRows: errors.length,
      recognizedColumns,
      missingRequiredColumns,
      unknownColumns
    }
  };
}

function parseImportedEntry(
  item: Record<string, unknown>
): { entry: Record<string, unknown> } | { error: string } {
  const rawAmountMinor = item.amount_minor;
  const rawAmount = item.amount;
  const inferredType = parseImportedType(item.type ?? item.kind ?? item.direction ?? rawAmountMinor ?? rawAmount);
  const amountMinor = rawAmountMinor !== undefined && rawAmountMinor !== null && String(rawAmountMinor).trim() !== ""
    ? parseImportedMinorAmount(rawAmountMinor)
    : parseImportedAmount(rawAmount);
  const categoryParts = splitImportedCategoryPath(
    String(item.category ?? item.categoryName ?? item.categoryPath ?? "").trim(),
    String(item.subcategory ?? item.subcategoryName ?? "").trim()
  );
  const categoryName = categoryParts.categoryName;
  const subcategoryName = categoryParts.subcategoryName;
  const description = normalizeNullableText(item.description ?? item.comment ?? item.note ?? "");
  const dateSource = item.datetime ?? item.date ?? item.entryDate ?? item.createdAt ?? "";
  const timeSource = item.time ?? item.entryTime ?? item.datetime ?? item.date ?? item.createdAt ?? "";
  const parsedDate = parseImportedDate(String(dateSource));
  const parsedTime = parseImportedTime(String(timeSource));

  if (amountMinor === null) {
    return { error: isEmptyImportValue(rawAmountMinor ?? rawAmount) ? "пустая сумма" : "сумма не читается" };
  }
  if (!inferredType) {
    return { error: "неизвестный тип" };
  }
  if (!categoryName) {
    return { error: "нет категории" };
  }

  return {
    entry: {
      type: inferredType,
      amountMinor,
      categoryName,
      subcategoryName: subcategoryName || null,
      description,
      entryDate: parsedDate.readable ? parsedDate.value : null,
      entryTime: parsedTime,
      isTimeAuto: !parsedTime,
      isDateMissing: !parsedDate.readable
    }
  };
}

export function parseFixCandidate(rawText: string): {
  type?: EntryType;
  amountMinor?: number;
  category?: string;
  subcategory?: string;
  description?: string;
  entryDate?: string | null;
  entryTime?: string | null;
  isDateMissing: boolean;
  isTimeAuto: boolean;
  missing: string[];
} {
  const parsed = parseEntryAttempt(rawText);
  const inferredType = parsed.type ?? inferImportTextType(rawText) ?? undefined;
  const categoryParts = splitImportedCategoryPath(parsed.category ?? "", parsed.subcategory ?? "");
  const extractedDate = extractDateFromText(rawText);
  const extractedTime = extractTimeFromText(rawText);
  const missing: string[] = parsed.missing.filter((item) => item !== "type");
  if (!inferredType) {
    missing.unshift("type");
  }
  if (!categoryParts.categoryName && !missing.includes("category")) {
    missing.push("category");
  }
  return {
    type: inferredType,
    amountMinor: parsed.amountMinor,
    category: categoryParts.categoryName || undefined,
    subcategory: categoryParts.subcategoryName || undefined,
    description: parsed.description,
    entryDate: extractedDate,
    entryTime: extractedTime,
    isDateMissing: !extractedDate,
    isTimeAuto: !extractedTime,
    missing
  };
}

function extractDateFromText(rawText: string): string | null {
  const isoMatch = rawText.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (isoMatch) {
    const parsed = parseImportedDate(isoMatch[0]);
    return parsed.readable ? parsed.value : null;
  }
  const dottedMatch = rawText.match(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/);
  if (dottedMatch) {
    const parsed = parseImportedDate(dottedMatch[0]);
    return parsed.readable ? parsed.value : null;
  }
  const slashMatch = rawText.match(/\b\d{4}\/\d{1,2}\/\d{1,2}\b/);
  if (slashMatch) {
    const parsed = parseImportedDate(slashMatch[0]);
    return parsed.readable ? parsed.value : null;
  }
  return null;
}

function extractTimeFromText(rawText: string): string | null {
  const timeMatch = rawText.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/);
  if (!timeMatch) {
    return null;
  }
  return parseImportedTime(timeMatch[0]);
}

function parseImportedAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(Math.abs(value) * 100);
  }
  const raw = normalizeImportNumberish(value);
  if (!raw) {
    return null;
  }
  const numeric = Number(normalizeImportNumber(raw));
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.round(Math.abs(numeric) * 100);
}

function parseImportedMinorAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(Math.abs(value));
  }
  const raw = normalizeImportNumberish(value);
  if (!raw) {
    return null;
  }
  const numeric = Number(normalizeImportNumber(raw));
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.round(Math.abs(numeric));
}

export function parseImportedDate(value: string): { readable: boolean; value: string | null } {
  const raw = normalizeNullableText(value);
  if (!raw) {
    return { readable: false, value: null };
  }
  const normalized = raw.replace(/\s+/g, " ").trim();
  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return { readable: true, value: `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}` };
  }
  const dottedMatch = normalized.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (dottedMatch) {
    const day = dottedMatch[1].padStart(2, "0");
    const month = dottedMatch[2].padStart(2, "0");
    const year = dottedMatch[3];
    return { readable: true, value: `${year}-${month}-${day}` };
  }
  const slashYearFirst = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (slashYearFirst) {
    const month = slashYearFirst[2].padStart(2, "0");
    const day = slashYearFirst[3].padStart(2, "0");
    return { readable: true, value: `${slashYearFirst[1]}-${month}-${day}` };
  }
  const parsed = new Date(normalized.replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) {
    return { readable: false, value: null };
  }
  return { readable: true, value: parsed.toISOString().slice(0, 10) };
}

export function parseImportedTime(value: string): string | null {
  const raw = normalizeNullableText(value);
  if (!raw) {
    return null;
  }
  const match = raw.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!match) {
    return null;
  }
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function parseImportedType(value: unknown): EntryType | null {
  const raw = normalizeNullableText(value)?.toLowerCase() ?? "";
  if (!raw) {
    return null;
  }
  if (["income", "доход", "+", "in", "credit", "deposit"].includes(raw)) {
    return "income";
  }
  if (["expense", "расход", "-", "out", "debit", "withdrawal"].includes(raw)) {
    return "expense";
  }
  if (raw.startsWith("+")) {
    return "income";
  }
  if (raw.startsWith("-")) {
    return "expense";
  }
  const numeric = Number(normalizeImportNumber(raw.replace(/\s+/g, "").replace(/[^0-9,.\-+]/g, "")));
  if (Number.isFinite(numeric)) {
    return numeric < 0 ? "expense" : "income";
  }
  return null;
}

function inferImportTextType(rawText: string): EntryType | null {
  const firstToken = rawText.trim().split(/\s+/)[0] ?? "";
  if (!firstToken) {
    return null;
  }
  return parseImportedType(firstToken);
}

function splitImportedCategoryPath(
  categoryRaw: string,
  subcategoryRaw: string
): { categoryName: string; subcategoryName: string | null } {
  const categoryName = normalizeNullableText(categoryRaw) ?? "";
  const explicitSubcategory = normalizeNullableText(subcategoryRaw) ?? "";
  if (!categoryName) {
    return { categoryName: "", subcategoryName: explicitSubcategory || null };
  }
  if (explicitSubcategory) {
    return { categoryName, subcategoryName: explicitSubcategory };
  }

  for (const separator of ["→", ">", "|", "/", ";", ",", ":"]) {
    if (!categoryName.includes(separator)) {
      continue;
    }
    const parts = categoryName
      .split(separator)
      .map((item) => normalizeNullableText(item) ?? "")
      .filter(Boolean);
    if (parts.length >= 2) {
      return {
        categoryName: parts[0] ?? "",
        subcategoryName: parts.slice(1).join(" / ") || null
      };
    }
  }

  return { categoryName, subcategoryName: null };
}

function splitCsvLine(line: string, delimiter = ","): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current.trim());
  return result;
}

function detectCsvDelimiter(headerLine: string): string {
  const delimiters = [",", ";", "\t"];
  let best = ",";
  let bestCount = -1;
  for (const delimiter of delimiters) {
    const count = splitCsvLine(headerLine, delimiter).length;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function normalizeImportHeader(value: string): { canonical: string | null; original: string } {
  const original = value.replace(/^\uFEFF/, "").trim();
  const raw = normalizeName(original).replace(/[^a-zа-я0-9]+/g, " ").trim();
  const map: Record<string, string> = {
    type: "type",
    тип: "type",
    direction: "type",
    kind: "type",
    operation: "type",
    "transaction type": "type",
    amount: "amount",
    "amount minor": "amount_minor",
    amountminor: "amount_minor",
    sum: "amount",
    сумма: "amount",
    value: "amount",
    money: "amount",
    date: "date",
    дата: "date",
    day: "date",
    datetime: "datetime",
    "date time": "datetime",
    "дата время": "datetime",
    "created at": "datetime",
    created: "datetime",
    "время операции": "datetime",
    time: "time",
    время: "time",
    category: "category",
    категория: "category",
    "category name": "category",
    "category path": "category",
    "категория подкатегория": "category",
    subcategory: "subcategory",
    "subcategory name": "subcategory",
    подкатегория: "subcategory",
    "sub category": "subcategory",
    note: "description",
    notes: "description",
    comment: "description",
    description: "description",
    описание: "description",
    примечание: "description"
  };

  return {
    canonical: map[raw] ?? null,
    original
  };
}

function normalizeImportValue(value: string): string {
  const trimmed = value.trim().replace(/^"(.*)"$/, "$1").trim();
  return normalizeNullableText(trimmed) ?? "";
}

function normalizeImportNumberish(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\(null\)/gi, "")
    .replace(/\bnull\b/gi, "")
    .replace(/\s+/g, "")
    .replace(/[^0-9,.\-+]/g, "");
}

function normalizeImportNumber(raw: string): string {
  const commas = (raw.match(/,/g) ?? []).length;
  const dots = (raw.match(/\./g) ?? []).length;

  if (commas > 0 && dots > 0) {
    if (raw.lastIndexOf(",") > raw.lastIndexOf(".")) {
      return raw.replace(/\./g, "").replace(",", ".");
    }
    return raw.replace(/,/g, "");
  }

  if (commas > 1) {
    return raw.replace(/,/g, "");
  }

  if (dots > 1) {
    const lastDot = raw.lastIndexOf(".");
    const fraction = raw.slice(lastDot + 1);
    if (fraction.length === 1 || fraction.length === 2) {
      return `${raw.slice(0, lastDot).replace(/\./g, "")}.${fraction}`;
    }
    return raw.replace(/\./g, "");
  }

  if (commas === 1) {
    const fraction = raw.split(",")[1] ?? "";
    return fraction.length <= 2 ? raw.replace(",", ".") : raw.replace(/,/g, "");
  }

  return raw;
}

function stringifyImportRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([key, value]) => `${key}: ${String(value ?? "")}`)
    .join(", ");
}

function isEmptyImportValue(value: unknown): boolean {
  return normalizeNullableText(value) === null;
}

function normalizeNullableText(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }
  if (/^\(null\)$/i.test(trimmed) || /^null$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function getMissingRequiredColumns(recognizedColumns: string[]): string[] {
  const set = new Set(recognizedColumns);
  const missing: string[] = [];
  if (!set.has("amount") && !set.has("amount_minor")) {
    missing.push("amount");
  }
  if (!set.has("category")) {
    missing.push("category");
  }
  if (!set.has("date") && !set.has("datetime")) {
    missing.push("date");
  }
  return missing;
}

function formatMissingColumnReason(field: string): string {
  if (field === "amount") {
    return "не распознана колонка суммы";
  }
  if (field === "category") {
    return "не распознана колонка категории";
  }
  if (field === "date") {
    return "не распознана колонка даты";
  }
  return "не распознана обязательная колонка";
}

function buildMeta(
  meta: Partial<ImportPreviewMeta> | undefined,
  validRows: number,
  invalidRows: number
): ImportPreviewMeta {
  return {
    format: meta?.format === "csv" || meta?.format === "json" ? meta.format : "unknown",
    totalRows: typeof meta?.totalRows === "number" ? meta.totalRows : validRows + invalidRows,
    validRows,
    invalidRows,
    recognizedColumns: Array.isArray(meta?.recognizedColumns) ? [...meta.recognizedColumns] : [],
    missingRequiredColumns: Array.isArray(meta?.missingRequiredColumns) ? [...meta.missingRequiredColumns] : [],
    unknownColumns: Array.isArray(meta?.unknownColumns) ? [...meta.unknownColumns] : []
  };
}
