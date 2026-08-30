import {
  type CreateTaskInput,
  type CreateWorkbookInput,
  IdSchema,
  TaskSchema,
  type TrueForgeTurn,
  type TrueForgeTurnInput,
  TrueForgeTurnInputSchema,
  TrueForgeTurnSchema,
  WorkbookSchema,
  WorkbookSnapshotSchema,
} from '@kalki/contracts';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { DomainError } from './errors.js';

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

  getSnapshot(workbookId: string) {
    const taskRows = this.database
      .prepare('SELECT * FROM tasks WHERE workbook_id = ? ORDER BY created_at')
      .all(workbookId);

    return WorkbookSnapshotSchema.parse({
      workbook: this.getWorkbook(workbookId),
      tasks: taskRows.map(row => TaskSchema.parse(row)),
      tables: [],
      runs: [],
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
}
