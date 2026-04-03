PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  onboarding_step INTEGER NOT NULL DEFAULT 0,
  onboarding_completed_at TEXT,
  timezone_name TEXT NOT NULL DEFAULT 'Europe/Moscow',
  timezone_source TEXT NOT NULL DEFAULT 'default',
  currency_code TEXT NOT NULL DEFAULT 'RUB',
  currency_label TEXT NOT NULL DEFAULT '₽',
  subcategories_enabled INTEGER NOT NULL DEFAULT 1,
  quick_access_mode_expense TEXT NOT NULL DEFAULT 'automatically',
  quick_access_mode_income TEXT NOT NULL DEFAULT 'automatically',
  quick_access_mode_subcategories TEXT NOT NULL DEFAULT 'automatically',
  sort_mode_expense TEXT NOT NULL DEFAULT 'usage',
  sort_mode_income TEXT NOT NULL DEFAULT 'usage',
  sort_mode_subcategories TEXT NOT NULL DEFAULT 'usage',
  onboarding_dismissed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  hidden_at TEXT,
  quick_access_slot INTEGER,
  sort_mode_override TEXT,
  usage_count_cache INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, type, normalized_name)
);

CREATE TABLE IF NOT EXISTS subcategories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  hidden_at TEXT,
  quick_access_slot INTEGER,
  usage_count_cache INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
  UNIQUE (category_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  amount_minor INTEGER NOT NULL,
  currency_label TEXT NOT NULL,
  category_id INTEGER NOT NULL,
  subcategory_id INTEGER,
  description TEXT,
  entry_date TEXT,
  entry_time TEXT,
  entry_datetime_sort TEXT,
  is_time_auto INTEGER NOT NULL DEFAULT 0,
  is_date_missing INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  external_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT,
  FOREIGN KEY (subcategory_id) REFERENCES subcategories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  current_step TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS intake_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  parsed_json TEXT NOT NULL,
  missing_fields_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'skipped', 'saved')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ui_sessions (
  user_id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL,
  stack_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS saved_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  view_type TEXT NOT NULL,
  params_json TEXT NOT NULL,
  result_ids_json TEXT NOT NULL,
  cursor_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  import_type TEXT NOT NULL,
  status TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  parsed_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'error', 'saved', 'skipped')),
  failure_reason TEXT,
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_categories_user_type_hidden ON categories(user_id, type, hidden_at, usage_count_cache DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subcategories_category_hidden ON subcategories(category_id, hidden_at, usage_count_cache DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_user_sort ON entries(user_id, entry_datetime_sort DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_entries_user_type_sort ON entries(user_id, type, entry_datetime_sort DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_entries_user_category_sort ON entries(user_id, category_id, entry_datetime_sort DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_entries_user_subcategory_sort ON entries(user_id, subcategory_id, entry_datetime_sort DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_entries_external_hash ON entries(user_id, external_hash);
CREATE INDEX IF NOT EXISTS idx_intake_queue_user_status ON intake_queue(user_id, status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_import_rows_import_status ON import_rows(import_id, status, id ASC);
