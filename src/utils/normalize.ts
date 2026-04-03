export function normalizeName(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase().replaceAll("ё", "е");
}

export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
