export function encodeCallback(action: string, payload: Record<string, string | number | undefined> = {}): string {
  const params = new URLSearchParams();
  params.set("a", action);
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  return params.toString().slice(0, 64);
}

export function decodeCallback(data: string | undefined): Record<string, string> {
  if (!data) {
    return {};
  }
  return Object.fromEntries(new URLSearchParams(data).entries());
}
