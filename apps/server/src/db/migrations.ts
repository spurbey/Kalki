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
  {
    version: 3,
    sql: `
      CREATE TABLE tables (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('source', 'derived')),
        ordinal INTEGER NOT NULL,
        schema_path TEXT NOT NULL,
        schema_json TEXT NOT NULL,
        schema_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, slug),
        UNIQUE(task_id, ordinal)
      );

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        mode TEXT NOT NULL CHECK (mode IN ('test', 'production')),
        status TEXT NOT NULL,
        task_hash TEXT NOT NULL,
        schema_hash TEXT NOT NULL,
        pipeline_hash TEXT NOT NULL,
        approved_at TEXT,
        approval_event_id TEXT,
        approved_task_hash TEXT,
        approved_schema_hash TEXT,
        approved_pipeline_hash TEXT,
        test_manifest_json TEXT,
        test_samples_json TEXT,
        published_row_count INTEGER NOT NULL DEFAULT 0,
        total_record_count INTEGER,
        error_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_tables_task_ordinal ON tables(task_id, ordinal);
      CREATE INDEX idx_runs_task_created ON runs(task_id, created_at);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE agent_questions (
        id TEXT PRIMARY KEY,
        workbook_id TEXT NOT NULL REFERENCES workbooks(id),
        task_id TEXT REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id),
        gate_kind TEXT NOT NULL CHECK (
          gate_kind IN ('clarification', 'task_review', 'schema_review', 'production_review', 'skill_promotion_review')
        ),
        question_turn_id TEXT NOT NULL REFERENCES trueforge_turns(id),
        question_event_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        question_text TEXT NOT NULL,
        options_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'submitting', 'answered', 'submission_unknown', 'invalidated')
        ),
        answer_text TEXT,
        decision TEXT CHECK (decision IN ('approve', 'revise', 'skip', 'cancel', 'free_text')),
        answer_turn_id TEXT REFERENCES trueforge_turns(id),
        created_at TEXT NOT NULL,
        answered_at TEXT,
        UNIQUE(workbook_id, tool_call_id),
        UNIQUE(workbook_id, question_event_id)
      );

      CREATE INDEX idx_agent_questions_workbook_status
        ON agent_questions(workbook_id, status, created_at);
    `,
  },
] as const;
