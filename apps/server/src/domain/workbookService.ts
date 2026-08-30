import {
  type CreateTaskInput,
  type CreateWorkbookInput,
  type GetWorkbookContextInput,
  GetWorkbookContextDataSchema,
  GetWorkbookContextInputSchema,
  IdSchema,
  type RegisterSchemaInput,
  RegisterSchemaDataSchema,
  RegisterSchemaInputSchema,
  type RegisterTaskInput,
  RegisterTaskDataSchema,
  RegisterTaskInputSchema,
  RunSchema,
  SlugSchema,
  type StartRunInput,
  StartRunDataSchema,
  StartRunInputSchema,
  TableKindSchema,
  TableSchema,
  TaskSchema,
  type TrueForgeTurn,
  type TrueForgeTurnInput,
  TrueForgeTurnInputSchema,
  TrueForgeTurnSchema,
  WorkbookSchema,
  WorkbookSnapshotSchema,
} from '@kalki/contracts';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from './errors.js';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Value is not JSON serializable');
  return serialized;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function aggregateSchemaHash(tables: Array<{ schema_path: string; schema_hash: string }>): string | null {
  if (tables.length === 0) return null;
  return hashJson(
    tables
      .map((table) => ({ path: table.schema_path, sha256: table.schema_hash }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  );
}

export class WorkbookService {
  constructor(private readonly database: Database.Database) {}

  createWorkbook(input: CreateWorkbookInput) {
    const timestamp = new Date().toISOString();
    const workbook = WorkbookSchema.parse({
      id: `wb_${randomUUID()}`,
      title: input.title,
      trueforge_session_id: null,
      current_trueforge_turn_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    });

    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO workbooks(
             id, title, trueforge_session_id, current_trueforge_turn_id, created_at, updated_at
           ) VALUES (
             @id, @title, @trueforge_session_id, @current_trueforge_turn_id, @created_at, @updated_at
           )`,
        )
        .run(workbook);
      this.database
        .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(workbook.id, 'workbook.created', JSON.stringify({ workbook_id: workbook.id }), timestamp);
    })();

    return workbook;
  }

  createTask(workbookId: string, input: CreateTaskInput) {
    if (!this.database.prepare('SELECT 1 FROM workbooks WHERE id = ?').get(workbookId)) {
      throw new DomainError(`Workbook '${workbookId}' was not found`, 'not_found', 404);
    }

    const timestamp = new Date().toISOString();
    const task = TaskSchema.parse({
      id: `task_${randomUUID()}`,
      workbook_id: workbookId,
      slug: input.slug,
      title: input.title,
      objective: input.objective,
      state: 'aligning',
      task_path: null,
      task_markdown: null,
      task_hash: null,
      created_at: timestamp,
      updated_at: timestamp,
    });

    try {
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO tasks(
               id, workbook_id, slug, title, objective, state, task_path, task_markdown, task_hash,
               created_at, updated_at
             ) VALUES (
               @id, @workbook_id, @slug, @title, @objective, @state, @task_path, @task_markdown, @task_hash,
               @created_at, @updated_at
             )`,
          )
          .run(task);
        this.database
          .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
          .run(workbookId, 'task.created', JSON.stringify({ task_id: task.id }), timestamp);
      })();
    } catch (error) {
      if (
        error instanceof Database.SqliteError &&
        error.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
        error.message.includes('tasks.workbook_id, tasks.slug')
      ) {
        throw new DomainError(`Task slug '${input.slug}' already exists in this workbook`, 'task_slug_conflict', 409);
      }
      throw error;
    }

    return task;
  }

  getWorkbook(workbookId: string) {
    const row = this.database.prepare('SELECT * FROM workbooks WHERE id = ?').get(workbookId);
    if (!row) throw new DomainError(`Workbook '${workbookId}' was not found`, 'not_found', 404);
    return WorkbookSchema.parse(row);
  }

  connectTrueForgeSession(workbookId: string, sessionId: string) {
    const validSessionId = IdSchema.parse(sessionId);
    const workbook = this.getWorkbook(workbookId);
    if (workbook.trueforge_session_id === validSessionId) return workbook;
    if (workbook.trueforge_session_id) {
      throw new DomainError('Workbook is already connected to TrueForge', 'workbook_already_connected', 409);
    }
    const sessionOwner = this.database
      .prepare('SELECT id FROM workbooks WHERE trueforge_session_id = ?')
      .get(validSessionId) as { id: string } | undefined;
    if (sessionOwner) {
      throw new DomainError('TrueForge session is already connected to another workbook', 'session_already_connected', 409);
    }

    const timestamp = new Date().toISOString();
    this.database.transaction(() => {
      this.database
        .prepare('UPDATE workbooks SET trueforge_session_id = ?, updated_at = ? WHERE id = ?')
        .run(validSessionId, timestamp, workbookId);
      this.database
        .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(workbookId, 'workbook.connected', JSON.stringify({ session_id: validSessionId }), timestamp);
    })();

    return this.getWorkbook(workbookId);
  }

  getCurrentTrueForgeTurn(workbookId: string): TrueForgeTurn | null {
    const workbook = this.getWorkbook(workbookId);
    if (!workbook.current_trueforge_turn_id) return null;
    const row = this.database
      .prepare('SELECT * FROM trueforge_turns WHERE id = ?')
      .get(workbook.current_trueforge_turn_id);
    return row ? this.parseTrueForgeTurn(row) : null;
  }

  saveTrueForgeTurn(workbookId: string, input: TrueForgeTurnInput) {
    const turn = TrueForgeTurnInputSchema.parse(input);
    const workbook = this.getWorkbook(workbookId);
    if (workbook.trueforge_session_id !== turn.sessionId) {
      throw new DomainError('TrueForge turn does not belong to this workbook session', 'turn_session_mismatch', 409);
    }
    const turnOwner = this.database.prepare('SELECT workbook_id FROM trueforge_turns WHERE id = ?').get(turn.id) as
      | { workbook_id: string }
      | undefined;
    if (turnOwner && turnOwner.workbook_id !== workbookId) {
      throw new DomainError('TrueForge turn is already stored for another workbook', 'turn_already_connected', 409);
    }

    const timestamp = new Date().toISOString();
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO trueforge_turns(
             id, workbook_id, previous_turn_id, status, last_sequence_number, required_actions_json,
             started_at, finished_at, updated_at
           ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             required_actions_json = excluded.required_actions_json,
             finished_at = excluded.finished_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          turn.id,
          workbookId,
          turn.previousTurnId,
          turn.status,
          JSON.stringify(turn.requiredActions),
          turn.createdAt,
          turn.finishedAt,
          timestamp,
        );
      this.database
        .prepare('UPDATE workbooks SET current_trueforge_turn_id = ?, updated_at = ? WHERE id = ?')
        .run(turn.id, timestamp, workbookId);
    })();

    const row = this.database.prepare('SELECT * FROM trueforge_turns WHERE id = ?').get(turn.id);
    return this.parseTrueForgeTurn(row);
  }

  getWorkbookContext(input: GetWorkbookContextInput) {
    const context = GetWorkbookContextInputSchema.parse(input);
    const snapshot = this.getSnapshot(context.workbook_id);
    const task = context.task_id
      ? snapshot.tasks.find((candidate) => candidate.id === context.task_id)
      : snapshot.tasks.length === 1
        ? snapshot.tasks[0]
        : null;

    if (context.task_id && !task) {
      throw new DomainError(`Task '${context.task_id}' was not found in this workbook`, 'task_not_found', 404);
    }
    if (!input.task_id && snapshot.tasks.length > 1) {
      throw new DomainError('task_id is required when a workbook has multiple tasks', 'ambiguous_task', 409);
    }

    let nextExpectedAction = 'continue_workflow';
    if (!task) nextExpectedAction = 'create_task';
    else if (task.state === 'aligning') nextExpectedAction = 'author_task';
    else if (task.state === 'awaiting_task_confirmation') nextExpectedAction = 'ask_task_review';
    else if (task.state === 'exploring') nextExpectedAction = 'register_schema';
    else if (task.state === 'awaiting_schema_review') nextExpectedAction = 'ask_schema_review';
    else if (task.state === 'building') nextExpectedAction = 'start_test_run';
    else if (task.state === 'testing') nextExpectedAction = 'complete_test_run';

    return GetWorkbookContextDataSchema.parse({
      workbook: {
        id: snapshot.workbook.id,
        title: snapshot.workbook.title,
        trueforge_session_id: snapshot.workbook.trueforge_session_id,
        current_trueforge_turn_id: snapshot.workbook.current_trueforge_turn_id,
      },
      task: task
        ? {
            id: task.id,
            state: task.state,
            task_path: task.task_path,
            task_hash: task.task_hash,
          }
        : null,
      tables: snapshot.tables.map((table) => ({
        id: table.id,
        slug: table.slug,
        kind: table.kind,
        schema_hash: table.schema_hash,
      })),
      aggregate_schema_hash: aggregateSchemaHash(snapshot.tables),
      runs: snapshot.runs.map((run) => ({
        id: run.id,
        mode: run.mode,
        status: run.status,
        hashes: {
          task: run.task_hash,
          schema: run.schema_hash,
          pipeline: run.pipeline_hash,
        },
        counts: { formal_rows: run.published_row_count },
      })),
      pending_question: snapshot.pending_question,
      artifacts: snapshot.artifacts,
      generated_skills: snapshot.generated_skills,
      next_expected_action: nextExpectedAction,
    });
  }

  registerTask(input: RegisterTaskInput) {
    const registration = RegisterTaskInputSchema.parse(input);
    const row = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(registration.task_id);
    if (!row) throw new DomainError(`Task '${registration.task_id}' was not found`, 'task_not_found', 404);
    const task = TaskSchema.parse(row);
    const canonicalMarkdown = registration.task_markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const actualHash = createHash('sha256').update(canonicalMarkdown, 'utf8').digest('hex');

    if (actualHash !== registration.task_hash) {
      throw new DomainError('task_hash does not match task_markdown', 'task_hash_mismatch', 400);
    }

    const result = RegisterTaskDataSchema.parse({
      task_id: task.id,
      state: 'awaiting_task_confirmation' as const,
      task_path: registration.task_path,
      task_hash: registration.task_hash,
      next_action: 'ask_task_review',
    });
    if (
      task.state === 'awaiting_task_confirmation' &&
      task.task_path === registration.task_path &&
      task.task_hash === registration.task_hash &&
      task.task_markdown === canonicalMarkdown
    ) {
      return result;
    }
    if (task.state !== 'aligning') {
      throw new DomainError(`Task cannot be registered while it is '${task.state}'`, 'invalid_task_state', 409);
    }

    const timestamp = new Date().toISOString();
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE tasks
           SET state = ?, task_path = ?, task_markdown = ?, task_hash = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(result.state, registration.task_path, canonicalMarkdown, registration.task_hash, timestamp, task.id);
      this.database
        .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(
          task.workbook_id,
          'task.registered',
          JSON.stringify({
            task_id: task.id,
            state: result.state,
            task_hash: registration.task_hash,
          }),
          timestamp,
        );
    })();

    return result;
  }

  registerSchema(input: RegisterSchemaInput) {
    const registration = RegisterSchemaInputSchema.parse(input);
    const row = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(registration.task_id);
    if (!row) throw new DomainError(`Task '${registration.task_id}' was not found`, 'task_not_found', 404);
    const task = TaskSchema.parse(row);

    const seenSlugs = new Set<string>();
    const tables = registration.schemas.map((item, ordinal) => {
      const metadata = item.schema.table;
      if (
        item.schema.version !== 1 ||
        !metadata ||
        typeof metadata !== 'object' ||
        Array.isArray(metadata) ||
        !Array.isArray(item.schema.columns) ||
        item.schema.columns.length === 0
      ) {
        throw new DomainError(`Schema '${item.path}' is invalid`, 'schema_validation_failed', 400);
      }

      const table = metadata as Record<string, unknown>;
      const slug = SlugSchema.safeParse(table.slug);
      const kind = TableKindSchema.safeParse(table.kind);
      const name = typeof table.name === 'string' ? table.name.trim() : '';
      if (!slug.success || !kind.success || !name || item.path !== `schemas/${slug.data}.yaml`) {
        throw new DomainError(`Schema '${item.path}' has invalid table metadata`, 'schema_validation_failed', 400);
      }
      if (seenSlugs.has(slug.data)) {
        throw new DomainError(`Table slug '${slug.data}' is duplicated`, 'schema_set_invalid', 400);
      }
      seenSlugs.add(slug.data);

      const actualHash = hashJson(item.schema);
      if (actualHash !== item.schema_hash) {
        throw new DomainError(`schema_hash does not match '${item.path}'`, 'schema_hash_mismatch', 400);
      }

      return TableSchema.parse({
        id: `table_${randomUUID()}`,
        task_id: task.id,
        slug: slug.data,
        name,
        kind: kind.data,
        ordinal,
        schema_path: item.path,
        schema: item.schema,
        schema_hash: item.schema_hash,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    });

    if (tables.filter((table) => table.kind === 'source').length !== 1) {
      throw new DomainError('Schema set must contain exactly one source table', 'schema_set_invalid', 400);
    }
    const actualAggregateHash = aggregateSchemaHash(tables);
    if (actualAggregateHash !== registration.aggregate_schema_hash) {
      throw new DomainError('aggregate_schema_hash does not match schemas', 'aggregate_schema_hash_mismatch', 400);
    }

    const existing = this.database
      .prepare('SELECT * FROM tables WHERE task_id = ? ORDER BY ordinal')
      .all(task.id)
      .map((table) => this.parseTable(table));
    const resultFor = (registeredTables: typeof tables) =>
      RegisterSchemaDataSchema.parse({
        task_id: task.id,
        state: 'awaiting_schema_review',
        tables: registeredTables.map(({ id, slug, kind, schema_hash }) => ({
          id,
          slug,
          kind,
          schema_hash,
        })),
        aggregate_schema_hash: registration.aggregate_schema_hash,
        next_action: 'ask_schema_review',
      });

    if (
      task.state === 'awaiting_schema_review' &&
      existing.length === tables.length &&
      existing.every(
        (table, index) =>
          table.schema_path === tables[index]?.schema_path && table.schema_hash === tables[index]?.schema_hash,
      )
    ) {
      return resultFor(existing);
    }
    if (task.state !== 'exploring') {
      throw new DomainError(`Schemas cannot be registered while task is '${task.state}'`, 'invalid_task_state', 409);
    }

    const timestamp = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM tables WHERE task_id = ?').run(task.id);
      const insert = this.database.prepare(
        `INSERT INTO tables(
           id, task_id, slug, name, kind, ordinal, schema_path, schema_json, schema_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const table of tables) {
        insert.run(
          table.id,
          table.task_id,
          table.slug,
          table.name,
          table.kind,
          table.ordinal,
          table.schema_path,
          canonicalJson(table.schema),
          table.schema_hash,
          timestamp,
          timestamp,
        );
      }
      this.database
        .prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?')
        .run('awaiting_schema_review', timestamp, task.id);
      this.database
        .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(
          task.workbook_id,
          'schema.registered',
          JSON.stringify({
            task_id: task.id,
            aggregate_schema_hash: registration.aggregate_schema_hash,
          }),
          timestamp,
        );
    })();

    return resultFor(tables);
  }

  startRun(input: StartRunInput) {
    const requested = StartRunInputSchema.parse(input);
    const existingRow = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(requested.run_id);
    if (existingRow) {
      const existing = this.parseRun(existingRow);
      if (
        existing.task_id !== requested.task_id ||
        existing.mode !== requested.mode ||
        existing.task_hash !== requested.task_hash ||
        existing.schema_hash !== requested.schema_hash ||
        existing.pipeline_hash !== requested.pipeline_hash
      ) {
        throw new DomainError(`Run '${requested.run_id}' already has different inputs`, 'run_identity_conflict', 409);
      }
      return this.runResult(existing);
    }

    const taskRow = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(requested.task_id);
    if (!taskRow) throw new DomainError(`Task '${requested.task_id}' was not found`, 'task_not_found', 404);
    const task = TaskSchema.parse(taskRow);
    const tables = this.database
      .prepare('SELECT * FROM tables WHERE task_id = ? ORDER BY ordinal')
      .all(task.id)
      .map((table) => this.parseTable(table));
    if (task.task_hash !== requested.task_hash || aggregateSchemaHash(tables) !== requested.schema_hash) {
      throw new DomainError('Run hashes do not match the current task and schemas', 'hashes_not_current', 409);
    }

    if (requested.mode === 'test' && task.state !== 'building') {
      throw new DomainError(`Test run cannot start while task is '${task.state}'`, 'invalid_task_state', 409);
    }
    if (requested.mode === 'production') {
      if (task.state !== 'awaiting_production_confirmation') {
        throw new DomainError(`Production run cannot start while task is '${task.state}'`, 'invalid_task_state', 409);
      }
      const completedTest = this.database
        .prepare(
          `SELECT 1 FROM runs
           WHERE task_id = ? AND mode = 'test' AND status = 'completed'
             AND task_hash = ? AND schema_hash = ? AND pipeline_hash = ?`,
        )
        .get(task.id, requested.task_hash, requested.schema_hash, requested.pipeline_hash);
      if (!completedTest) throw new DomainError('A matching successful test is required', 'test_required', 409);
    }

    const timestamp = new Date().toISOString();
    const run = RunSchema.parse({
      id: requested.run_id,
      task_id: task.id,
      mode: requested.mode,
      status: requested.mode === 'test' ? 'running' : 'awaiting_confirmation',
      task_hash: requested.task_hash,
      schema_hash: requested.schema_hash,
      pipeline_hash: requested.pipeline_hash,
      approved_at: null,
      approval_event_id: null,
      approved_task_hash: null,
      approved_schema_hash: null,
      approved_pipeline_hash: null,
      test_manifest: null,
      test_samples: null,
      published_row_count: 0,
      total_record_count: null,
      error: null,
      created_at: timestamp,
      started_at: requested.mode === 'test' ? timestamp : null,
      finished_at: null,
      updated_at: timestamp,
    });

    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO runs(
             id, task_id, mode, status, task_hash, schema_hash, pipeline_hash,
             approved_at, approval_event_id, approved_task_hash, approved_schema_hash, approved_pipeline_hash,
             test_manifest_json, test_samples_json, published_row_count, total_record_count, error_json,
             created_at, started_at, finished_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.task_id,
          run.mode,
          run.status,
          run.task_hash,
          run.schema_hash,
          run.pipeline_hash,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          0,
          null,
          null,
          run.created_at,
          run.started_at,
          null,
          run.updated_at,
        );
      if (run.mode === 'test') {
        this.database
          .prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?')
          .run('testing', timestamp, task.id);
      }
      this.database
        .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(task.workbook_id, 'run.started', JSON.stringify({ run_id: run.id, mode: run.mode }), timestamp);
    })();

    return this.runResult(run);
  }

  getSnapshot(workbookId: string) {
    const taskRows = this.database
      .prepare('SELECT * FROM tasks WHERE workbook_id = ? ORDER BY created_at')
      .all(workbookId);
    const tableRows = this.database
      .prepare(
        `SELECT tables.* FROM tables
         JOIN tasks ON tasks.id = tables.task_id
         WHERE tasks.workbook_id = ? ORDER BY tables.ordinal`,
      )
      .all(workbookId);
    const runRows = this.database
      .prepare(
        `SELECT runs.* FROM runs
         JOIN tasks ON tasks.id = runs.task_id
         WHERE tasks.workbook_id = ? ORDER BY runs.created_at`,
      )
      .all(workbookId);

    return WorkbookSnapshotSchema.parse({
      workbook: this.getWorkbook(workbookId),
      tasks: taskRows.map(row => TaskSchema.parse(row)),
      tables: tableRows.map((row) => this.parseTable(row)),
      runs: runRows.map((row) => this.parseRun(row)),
      pending_question: null,
      artifacts: [],
      generated_skills: [],
      table_counts: {},
    });
  }

  private parseTrueForgeTurn(row: unknown) {
    if (!row || typeof row !== 'object') throw new Error('TrueForge turn was not persisted');
    const stored = row as Record<string, unknown>;
    return TrueForgeTurnSchema.parse({
      id: stored.id,
      workbook_id: stored.workbook_id,
      previous_turn_id: stored.previous_turn_id,
      status: stored.status,
      last_sequence_number: stored.last_sequence_number,
      required_actions: JSON.parse(String(stored.required_actions_json)) as unknown,
      started_at: stored.started_at,
      finished_at: stored.finished_at,
      updated_at: stored.updated_at,
    });
  }

  private parseTable(row: unknown) {
    if (!row || typeof row !== 'object') throw new Error('Table was not persisted');
    const { schema_json: schemaJson, ...stored } = row as Record<string, unknown>;
    return TableSchema.parse({
      ...stored,
      schema: JSON.parse(String(schemaJson)) as unknown,
    });
  }

  private parseRun(row: unknown) {
    if (!row || typeof row !== 'object') throw new Error('Run was not persisted');
    const {
      test_manifest_json: testManifestJson,
      test_samples_json: testSamplesJson,
      error_json: errorJson,
      ...stored
    } = row as Record<string, unknown>;
    return RunSchema.parse({
      ...stored,
      test_manifest: testManifestJson ? JSON.parse(String(testManifestJson)) : null,
      test_samples: testSamplesJson ? JSON.parse(String(testSamplesJson)) : null,
      error: errorJson ? JSON.parse(String(errorJson)) : null,
    });
  }

  private runResult(run: ReturnType<WorkbookService['parseRun']>) {
    return StartRunDataSchema.parse({
      run_id: run.id,
      mode: run.mode,
      status: run.status,
      hashes: {
        task: run.task_hash,
        schema: run.schema_hash,
        pipeline: run.pipeline_hash,
      },
      next_action: run.mode === 'test' ? 'execute_test' : 'ask_production_review',
    });
  }
}
