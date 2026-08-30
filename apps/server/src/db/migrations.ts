export const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE workbooks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        trueforge_session_id TEXT UNIQUE,
        current_trueforge_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        workbook_id TEXT NOT NULL REFERENCES workbooks(id),
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        state TEXT NOT NULL,
        task_path TEXT,
        task_markdown TEXT,
        task_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workbook_id, slug)
      );

      CREATE TABLE workbook_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        workbook_id TEXT NOT NULL REFERENCES workbooks(id),
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_tasks_workbook ON tasks(workbook_id, created_at);
      CREATE INDEX idx_events_workbook_seq ON workbook_events(workbook_id, seq);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE trueforge_turns (
        id TEXT PRIMARY KEY,
        workbook_id TEXT NOT NULL REFERENCES workbooks(id),
        previous_turn_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'done', 'cancelled', 'error')),
        last_sequence_number INTEGER NOT NULL DEFAULT 0,
        required_actions_json TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_trueforge_turns_workbook_started
        ON trueforge_turns(workbook_id, started_at);
    `,
  },
] as const;
