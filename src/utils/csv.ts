type CsvExportEntry = {
  date: string | null;
  time: string | null;
  amountMinor: number;
  type: "income" | "expense";
  category: string;
  subcategory: string | null;
  description: string | null;
};

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll("\"", "\"\"")}"`;
  }
  return value;
}

function formatMajorAmount(amountMinor: number): string {
  const absolute = Math.abs(amountMinor);
  const whole = Math.trunc(absolute / 100);
  const fraction = absolute % 100;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, "0")}`;
}

export function serializeEntriesCsv(entries: CsvExportEntry[]): string {
  const header = ["date", "time", "amount", "type", "category", "subcategory", "description"];
  const rows = entries.map((entry) => [
    entry.date ?? "",
    entry.time ?? "",
    formatMajorAmount(entry.amountMinor),
    entry.type,
    entry.category,
    entry.subcategory ?? "",
    entry.description ?? ""
  ]);

  return [header, ...rows]
    .map((row) => row.map((cell) => escapeCsvCell(cell)).join(","))
    .join("\n");
}
