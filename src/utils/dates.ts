import { isUtcOffsetZone } from "@/utils/timezone";

export function nowIso(): string {
  return new Date().toISOString();
}

export function splitNowForUser(timezone: string): { date: string; time: string; sort: string } {
  const date = new Date();
  if (isUtcOffsetZone(timezone)) {
    return splitNowForOffset(timezone, date);
  }
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.filter((item) => item.type !== "literal").map((item) => [item.type, item.value]));
  const isoDate = `${lookup.year}-${lookup.month}-${lookup.day}`;
  const isoTime = `${lookup.hour}:${lookup.minute}:${lookup.second}`;
  return {
    date: isoDate,
    time: isoTime,
    sort: `${isoDate}T${isoTime}`
  };
}

export function parseQuickPeriod(period: "today" | "yesterday" | "week" | "month" | "year" | "all", baseDate = new Date()): {
  from: string | null;
  to: string | null;
} {
  const end = new Date(baseDate);
  end.setHours(23, 59, 59, 999);
  const start = new Date(baseDate);
  start.setHours(0, 0, 0, 0);

  if (period === "yesterday") {
    start.setDate(start.getDate() - 1);
    end.setDate(end.getDate() - 1);
  } else if (period === "week") {
    start.setDate(start.getDate() - 6);
  } else if (period === "month") {
    start.setDate(1);
  } else if (period === "year") {
    start.setMonth(0, 1);
  } else if (period === "all") {
    return { from: null, to: null };
  }

  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10)
  };
}

export type ParsedCustomPeriod =
  | {
      status: "resolved";
      from: string | null;
      to: string | null;
      label: string;
    }
  | {
      status: "ambiguous";
      from: string | null;
      to: string | null;
      label: string;
    }
  | {
      status: "unparsed";
    };

export function parseCustomPeriodInput(input: string, todayIso: string): ParsedCustomPeriod {
  const raw = input.trim().toLowerCase();
  if (!raw) {
    return { status: "unparsed" };
  }

  if (raw === "сегодня") {
    const range = parseQuickPeriod("today", new Date(`${todayIso}T12:00:00Z`));
    return { status: "resolved", ...range, label: "сегодня" };
  }
  if (raw === "вчера") {
    const range = parseQuickPeriod("yesterday", new Date(`${todayIso}T12:00:00Z`));
    return { status: "resolved", ...range, label: "вчера" };
  }
  if (raw === "неделя") {
    const range = parseQuickPeriod("week", new Date(`${todayIso}T12:00:00Z`));
    return { status: "resolved", ...range, label: "неделя" };
  }
  if (raw === "месяц") {
    const range = parseQuickPeriod("month", new Date(`${todayIso}T12:00:00Z`));
    return { status: "resolved", ...range, label: "месяц" };
  }
  if (raw === "год") {
    const range = parseQuickPeriod("year", new Date(`${todayIso}T12:00:00Z`));
    return { status: "resolved", ...range, label: "год" };
  }
  if (raw === "всё время") {
    const range = parseQuickPeriod("all");
    return { status: "resolved", ...range, label: "всё время" };
  }

  const relativeMatch = raw.match(/^(?:последние\s+)?(\d+)\s*(дн(?:я|ей)?|недел[яиь]|месяц(?:а|ев)?|год(?:а|ов)?)$/);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2];
    const toDate = new Date(`${todayIso}T12:00:00Z`);
    const fromDate = new Date(toDate);
    if (unit.startsWith("д")) {
      fromDate.setUTCDate(fromDate.getUTCDate() - (amount - 1));
    } else if (unit.startsWith("нед")) {
      fromDate.setUTCDate(fromDate.getUTCDate() - amount * 7 + 1);
    } else if (unit.startsWith("м")) {
      fromDate.setUTCMonth(fromDate.getUTCMonth() - amount);
      fromDate.setUTCDate(fromDate.getUTCDate() + 1);
    } else {
      fromDate.setUTCFullYear(fromDate.getUTCFullYear() - amount);
      fromDate.setUTCDate(fromDate.getUTCDate() + 1);
    }
    return {
      status: "resolved",
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
      label: input.trim()
    };
  }

  const yearOnly = raw.match(/^(\d{4})$/);
  if (yearOnly) {
    return {
      status: "resolved",
      from: `${yearOnly[1]}-01-01`,
      to: `${yearOnly[1]}-12-31`,
      label: yearOnly[1]
    };
  }

  const isoMonth = raw.match(/^(\d{4})-(\d{2})$/);
  if (isoMonth) {
    return monthRange(Number(isoMonth[1]), Number(isoMonth[2]), false, `${isoMonth[1]}-${isoMonth[2]}`);
  }

  const dottedMonth = raw.match(/^(\d{2})\.(\d{4})$/);
  if (dottedMonth) {
    return monthRange(Number(dottedMonth[2]), Number(dottedMonth[1]), true, `${dottedMonth[1]}.${dottedMonth[2]}`);
  }

  const isoDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) {
    const date = `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;
    return { status: "resolved", from: date, to: date, label: date };
  }

  const dottedFull = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dottedFull) {
    const date = toIsoDate(Number(dottedFull[3]), Number(dottedFull[2]), Number(dottedFull[1]));
    return date ? { status: "resolved", from: date, to: date, label: normalizeDateLabel(date) } : { status: "unparsed" };
  }

  const dottedShort = raw.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (dottedShort) {
    const currentYear = Number(todayIso.slice(0, 4));
    const date = toIsoDate(currentYear, Number(dottedShort[2]), Number(dottedShort[1]));
    return date ? { status: "ambiguous", from: date, to: date, label: normalizeDateLabel(date) } : { status: "unparsed" };
  }

  const monthName = parseMonthNamePeriod(raw, todayIso);
  if (monthName) {
    return monthName;
  }

  const range = parseRangePeriod(raw, todayIso);
  if (range) {
    return range;
  }

  return { status: "unparsed" };
}

function splitNowForOffset(offset: string, current: Date): { date: string; time: string; sort: string } {
  const sign = offset.startsWith("-") ? -1 : 1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  const shifted = new Date(current.getTime() + sign * (hours * 60 + minutes) * 60 * 1000);
  const iso = shifted.toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19);
  return { date, time, sort: `${date}T${time}` };
}

function parseRangePeriod(raw: string, todayIso: string): ParsedCustomPeriod | null {
  const parts = splitRangeParts(raw);
  if (!parts || parts.length !== 2) {
    return null;
  }
  const left = parseCustomPeriodInput(cleanRangeToken(parts[0]), todayIso);
  const right = parseCustomPeriodInput(cleanRangeToken(parts[1]), todayIso);
  if (left.status === "unparsed" || right.status === "unparsed" || !left.from || !right.to) {
    return null;
  }
  const status = left.status === "ambiguous" || right.status === "ambiguous" ? "ambiguous" : "resolved";
  return {
    status,
    from: left.from,
    to: right.to,
    label: `${left.label} — ${right.label}`
  };
}

function splitRangeParts(raw: string): string[] | null {
  const normalized = raw.trim().replace(/\s+/g, " ");
  const prefixed = raw.match(/^с\s+(.+?)\s+по\s+(.+)$/);
  if (prefixed) {
    return [prefixed[1], prefixed[2]];
  }
  if (raw.includes(" по ")) {
    return raw.split(/\s+по\s+/);
  }
  const emDash = raw.match(/^(.+?)\s*—\s*(.+)$/);
  if (emDash) {
    return [emDash[1], emDash[2]];
  }
  const wordTo = raw.match(/^(.+?)\s+до\s+(.+)$/);
  if (wordTo) {
    return [wordTo[1], wordTo[2]];
  }
  const dottedRange = raw.match(/^(\d{1,2}\.\d{1,2}(?:\.\d{4})?)\s*-\s*(\d{1,2}\.\d{1,2}(?:\.\d{4})?)$/);
  if (dottedRange) {
    return [dottedRange[1], dottedRange[2]];
  }
  const isoDateRange = raw.match(/^(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})$/);
  if (isoDateRange) {
    return [isoDateRange[1], isoDateRange[2]];
  }
  const monthRange = raw.match(/^(\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{4})$/);
  if (monthRange) {
    return [monthRange[1], monthRange[2]];
  }
  const yearRange = raw.match(/^(\d{4})\s*-\s*(\d{4})$/);
  if (yearRange) {
    return [yearRange[1], yearRange[2]];
  }
  const isoMonthRange = normalized.match(/^(\d{4}-\d{2})\s*-\s*(\d{4}-\d{2})$/);
  if (isoMonthRange) {
    return [isoMonthRange[1], isoMonthRange[2]];
  }
  const dateWithMonthNameRange = normalized.match(
    /^(\d{1,2}\s+[а-яё]+(?:\s+\d{4})?)\s*-\s*(\d{1,2}\s+[а-яё]+(?:\s+\d{4})?)$/
  );
  if (dateWithMonthNameRange) {
    return [dateWithMonthNameRange[1], dateWithMonthNameRange[2]];
  }
  return null;
}

function cleanRangeToken(token: string): string {
  return token.trim().replace(/^с\s+/, "").trim();
}

function parseMonthNamePeriod(raw: string, todayIso: string): ParsedCustomPeriod | null {
  const monthNames: Record<string, number> = {
    январь: 1,
    января: 1,
    февраль: 2,
    февраля: 2,
    март: 3,
    марта: 3,
    апрель: 4,
    апреля: 4,
    май: 5,
    мая: 5,
    июнь: 6,
    июня: 6,
    июль: 7,
    июля: 7,
    август: 8,
    августа: 8,
    сентябрь: 9,
    сентября: 9,
    октябрь: 10,
    октября: 10,
    ноябрь: 11,
    ноября: 11,
    декабрь: 12,
    декабря: 12
  };

  const parts = raw.split(/\s+/);
  if (!parts.length) {
    return null;
  }
  const month = monthNames[parts[0]];
  if (month) {
    if (parts.length > 2) {
      return null;
    }
    const year = parts[1] ? Number(parts[1]) : Number(todayIso.slice(0, 4));
    if (!Number.isFinite(year)) {
      return null;
    }
    return monthRange(year, month, parts.length === 1, parts.join(" "));
  }

  const day = Number(parts[0]);
  const monthByName = monthNames[parts[1] ?? ""];
  if (!Number.isFinite(day) || !monthByName) {
    return null;
  }
  if (parts.length > 3) {
    return null;
  }

  const year = parts[2] ? Number(parts[2]) : Number(todayIso.slice(0, 4));
  if (!Number.isFinite(year)) {
    return null;
  }
  const date = toIsoDate(year, monthByName, day);
  if (!date) {
    return { status: "unparsed" };
  }
  return {
    status: parts[2] ? "resolved" : "ambiguous",
    from: date,
    to: date,
    label: parts[2] ? `${day} ${parts[1]} ${parts[2]}` : `${day} ${parts[1]}`
  };
}

function monthRange(year: number, month: number, ambiguous: boolean, label: string): ParsedCustomPeriod {
  const start = toIsoDate(year, month, 1);
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = endDate.toISOString().slice(0, 10);
  if (!start) {
    return { status: "unparsed" };
  }
  return {
    status: ambiguous ? "ambiguous" : "resolved",
    from: start,
    to: end,
    label
  };
}

function toIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function normalizeDateLabel(value: string): string {
  return `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}`;
}
