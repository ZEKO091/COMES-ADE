PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  local_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  font_size INTEGER NOT NULL DEFAULT 26,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspaces_updated_at ON workspaces(updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at);
