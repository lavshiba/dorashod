export function nowIso(): string {
  return new Date().toISOString();
}

export function splitNowForUser(timezone: string): { date: string; time: string; sort: string } {
  const date = new Date();
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

export function parseQuickPeriod(period: "today" | "yesterday" | "week" | "month" | "year" | "all"): {
  from: string | null;
  to: string | null;
} {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(now);
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
