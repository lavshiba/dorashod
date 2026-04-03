export function parseAmountToMinor(raw: string): number | undefined {
  const normalized = raw.replace(",", ".").replace(/[^\d.+-]/g, "");
  if (!normalized || normalized === "+" || normalized === "-") {
    return undefined;
  }

  const amount = Number(normalized);
  if (!Number.isFinite(amount)) {
    return undefined;
  }

  return Math.round(Math.abs(amount) * 100);
}

export function formatAmountFromMinor(amountMinor: number, currencyLabel: string): string {
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  const major = (abs / 100).toFixed(2).replace(/\.00$/, "");
  return `${sign}${major} ${currencyLabel}`;
}
