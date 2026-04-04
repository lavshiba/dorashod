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
  const payloadTokens = amountMinor ? tokens.slice(1) : tokens;
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
    lines,
    missing,
    isBatch: false
  };
}
