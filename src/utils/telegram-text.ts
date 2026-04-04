export function formatTelegramScreenText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return normalized;
  }

  return normalized.replace(/\n{3,}/g, "\n\n");
}

export function isTelegramMessageNotModified(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.toLowerCase().includes("message is not modified");
}
