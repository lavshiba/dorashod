import { normalizeName } from "@/utils/normalize";

const CITY_TIMEZONES: Record<string, string> = {
  "москва": "Europe/Moscow",
  "санкт-петербург": "Europe/Moscow",
  "санкт петербург": "Europe/Moscow",
  "спб": "Europe/Moscow",
  "петербург": "Europe/Moscow",
  "хельсинки": "Europe/Helsinki",
  "екатеринбург": "Asia/Yekaterinburg",
  "новосибирск": "Asia/Novosibirsk",
  "владивосток": "Asia/Vladivostok",
  "калининград": "Europe/Kaliningrad",
  "лондон": "Europe/London",
  "париж": "Europe/Paris",
  "берлин": "Europe/Berlin",
  "дубай": "Asia/Dubai",
  "нью-йорк": "America/New_York",
  "нью йорк": "America/New_York",
  "токио": "Asia/Tokyo"
};

export function resolveTimezoneFromCity(input: string): string | null {
  const normalized = normalizeName(input);
  return CITY_TIMEZONES[normalized] ?? null;
}

export function resolveTimezoneFromLocation(latitude: number, longitude: number): string {
  const offset = Math.max(-12, Math.min(14, Math.round(longitude / 15)));
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset).toString().padStart(2, "0");
  return `${sign}${abs}:00`;
}

export function isUtcOffsetZone(value: string): boolean {
  return /^[+-]\d{2}:\d{2}$/.test(value);
}
