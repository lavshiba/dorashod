import type { EntryType, ParsedEntryAttempt } from "@/domain/types";
import { parseAmountToMinor } from "@/utils/money";

const KNOWN_PERIOD_WORDS = new Set(["сегодня", "вчера", "неделя", "месяц", "год"]);

export function parseEntryAttempt(text: string): ParsedEntryAttempt {
  const lines = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (lines.length > 1 && lines.every((line) => /^[-+]\d/.test(line))) {
    return {
      lines,
      missing: [],
      isBatch: true
    };
  }

  const joined = lines.join(" ").trim();
  const tokens = joined.split(/\s+/).filter(Boolean);
  const first = tokens[0] ?? "";
  const looksLikeAmountToken = /^[+-]?\d+(?:[.,]\d+)?$/.test(first);

  let type: EntryType | undefined;
  if (first.startsWith("-")) {
    type = "expense";
  }
  if (first.startsWith("+")) {
    type = "income";
  }

  const amountMinor = looksLikeAmountToken ? parseAmountToMinor(first) : undefined;
  let payloadTokens = amountMinor ? tokens.slice(1) : tokens;
  const parsedDateTime = extractTrailingDateTime(payloadTokens);
  if (parsedDateTime) {
    payloadTokens = parsedDateTime.remainingTokens;
  }
  const category = payloadTokens[0];
  const subcategory = payloadTokens.length > 1 ? payloadTokens[1] : undefined;
  const description =
    payloadTokens.length > 2 ? payloadTokens.slice(2).join(" ") : payloadTokens.length === 2 ? undefined : undefined;

  const missing: ParsedEntryAttempt["missing"] = [];
  if (!type) {
    missing.push("type");
  }
  if (!amountMinor) {
    missing.push("amount");
  }
  if (!category || KNOWN_PERIOD_WORDS.has(category.toLowerCase())) {
    missing.push("category");
  }

  return {
    type,
    amountMinor,
    category,
    subcategory,
    description,
    entryDate: parsedDateTime?.entryDate,
    entryTime: parsedDateTime?.entryTime,
    isTimeAuto: parsedDateTime?.isTimeAuto,
    isDateMissing: parsedDateTime?.isDateMissing,
    lines,
    missing,
    isBatch: false
  };
}

function extractTrailingDateTime(tokens: string[]): {
  remainingTokens: string[];
  entryDate: string | null;
  entryTime: string | null;
  isTimeAuto: boolean;
  isDateMissing: boolean;
} | null {
  if (tokens.length === 0) {
    return null;
  }

  const withTime = tokens.slice(-2).join(" ");
  const parsedDateTime = parseTrailingDateTime(withTime);
  if (parsedDateTime) {
    return {
      remainingTokens: tokens.slice(0, -2),
      ...parsedDateTime
    };
  }

  const parsedDate = parseTrailingDate(tokens[tokens.length - 1] ?? "");
  if (!parsedDate) {
    return null;
  }
  return {
    remainingTokens: tokens.slice(0, -1),
    entryDate: parsedDate,
    entryTime: null,
    isTimeAuto: true,
    isDateMissing: false
  };
}

function parseTrailingDateTime(value: string): {
  entryDate: string | null;
  entryTime: string | null;
  isTimeAuto: boolean;
  isDateMissing: boolean;
} | null {
  const match = value.match(/^(.+)\s+(\d{1,2}:\d{2}(?::\d{2})?)$/);
  if (!match) {
    return null;
  }
  const entryDate = parseTrailingDate(match[1] ?? "");
  const entryTime = parseTrailingTime(match[2] ?? "");
  if (!entryDate || !entryTime) {
    return null;
  }
  return {
    entryDate,
    entryTime,
    isTimeAuto: false,
    isDateMissing: false
  };
}

function parseTrailingDate(value: string): string | null {
  const raw = value.trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const dotted = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotted) {
    return `${dotted[3]}-${dotted[2].padStart(2, "0")}-${dotted[1].padStart(2, "0")}`;
  }
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    return `${slash[3]}-${slash[2].padStart(2, "0")}-${slash[1].padStart(2, "0")}`;
  }
  return null;
}

function parseTrailingTime(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) {
    return null;
  }
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}
