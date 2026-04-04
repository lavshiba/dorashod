PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user_update_locks (
  user_id INTEGER PRIMARY KEY,
  lock_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_update_locks_created ON user_update_locks(created_at DESC);
