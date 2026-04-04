const KEY_ALIASES: Record<string, string> = {
  id: "i",
  categoryId: "c",
  subcategoryId: "u",
  type: "t",
  page: "p",
  subpage: "s",
  source: "o",
  query: "q",
  field: "f",
  target: "g",
  section: "x",
  period: "r",
  step: "n",
  importId: "m",
  origin: "b",
  mode: "d",
  slot: "l"
};

const KEY_UNALIASES = Object.fromEntries(Object.entries(KEY_ALIASES).map(([key, alias]) => [alias, key]));

const VALUE_ALIASES: Record<string, Record<string, string>> = {
  type: {
    income: "i",
    expense: "e"
  },
  source: {
    operations: "o",
    search: "s",
    report: "r",
    category: "c",
    list: "l",
    hidden: "h",
    add: "a",
    queue: "q"
  },
  target: {
    home: "h",
    source: "s"
  },
  section: {
    expense: "e",
    income: "i",
    subcategories: "s"
  },
  period: {
    today: "t",
    yesterday: "y",
    week: "w",
    month: "m",
    year: "Y",
    all: "a",
    custom: "c"
  },
  mode: {
    custom: "c",
    auto: "a",
    disabled: "d",
    usage: "u",
    recent: "r",
    alphabet: "b"
  }
};

const VALUE_UNALIASES = Object.fromEntries(
  Object.entries(VALUE_ALIASES).map(([key, map]) => [key, Object.fromEntries(Object.entries(map).map(([value, alias]) => [alias, value]))])
);

export function encodeCallback(action: string, payload: Record<string, string | number | undefined> = {}): string {
  const params = new URLSearchParams();
  params.set("a", action);
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) {
      continue;
    }
    const encodedKey = KEY_ALIASES[key] ?? key;
    const stringValue = String(value);
    const encodedValue = VALUE_ALIASES[key]?.[stringValue] ?? stringValue;
    params.set(encodedKey, encodedValue);
  }

  let encoded = params.toString();
  if (encoded.length <= 64) {
    return encoded;
  }

  params.delete(KEY_ALIASES.query ?? "q");
  encoded = params.toString();
  if (encoded.length <= 64) {
    return encoded;
  }

  return encoded.slice(0, 64);
}

export function decodeCallback(data: string | undefined): Record<string, string> {
  if (!data) {
    return {};
  }

  const decoded: Record<string, string> = {};
  for (const [rawKey, rawValue] of new URLSearchParams(data).entries()) {
    const key = KEY_UNALIASES[rawKey] ?? rawKey;
    decoded[key] = VALUE_UNALIASES[key]?.[rawValue] ?? rawValue;
  }
  return decoded;
}
