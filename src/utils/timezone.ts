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
  if (latitude >= 54 && latitude <= 70 && longitude >= 19 && longitude <= 40) {
    return "Europe/Moscow";
  }
  if (latitude >= 58 && latitude <= 71 && longitude >= 20 && longitude <= 32) {
    return "Europe/Helsinki";
  }
  if (latitude >= 51 && latitude <= 56 && longitude >= 34 && longitude <= 66) {
    return "Asia/Yekaterinburg";
  }
  if (latitude >= 50 && latitude <= 60 && longitude >= 66 && longitude <= 90) {
    return "Asia/Novosibirsk";
  }
  if (latitude >= 40 && latitude <= 49 && longitude >= 51 && longitude <= 57) {
    return "Asia/Dubai";
  }
  if (latitude >= 40 && latitude <= 61 && longitude >= -10 && longitude <= 30) {
    return "Europe/Berlin";
  }
  if (latitude >= 24 && latitude <= 50 && longitude >= -126 && longitude <= -66) {
    return "America/New_York";
  }
  if (latitude >= 30 && latitude <= 46 && longitude >= 129 && longitude <= 146) {
    return "Asia/Tokyo";
  }
  return "Europe/Moscow";
}

export function isUtcOffsetZone(value: string): boolean {
  return /^[+-]\d{2}:\d{2}$/.test(value);
}
