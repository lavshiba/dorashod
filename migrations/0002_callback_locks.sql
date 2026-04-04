PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS callback_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  callback_data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, message_id, callback_data)
);

CREATE INDEX IF NOT EXISTS idx_callback_locks_user_created ON callback_locks(user_id, created_at DESC);
