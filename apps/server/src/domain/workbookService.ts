import {
  ApprovalEventSchema,
  AnswerQuestionInputSchema,
  AgentQuestionSchema,
  ArtifactSchema,
  canTransitionTask,
  canonicalJson,
  type CompleteRunInput,
  CompleteRunInputSchema,
  type AgentQuestion,
  type AnswerQuestionInput,
  type CreateTaskInput,
  type CreateWorkbookInput,
  type GetWorkbookContextInput,
  GetWorkbookContextDataSchema,
  GetWorkbookContextInputSchema,
  IdSchema,
  MAX_TEST_SAMPLE_RECORDS_PER_TABLE,
  type ProductionAuthorizationInput,
  ProductionAuthorizationInputSchema,
  type PublishBatchInput,
  PublishBatchInputSchema,
  type RecordArtifactInput,
  RecordArtifactInputSchema,
  type RegisterSchemaInput,
  RegisterSchemaDataSchema,
  RegisterSchemaInputSchema,
  type RegisterTaskInput,
  RegisterTaskDataSchema,
  RegisterTaskInputSchema,
  RunSchema,
  RunBatchSchema,
  type Task,
  type StartRunInput,
  StartRunDataSchema,
  StartRunInputSchema,
  TableSchema,
  TableRowSchema,
  TableSchemaDocumentSchema,
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

type TableDocument = ReturnType<typeof TableSchemaDocumentSchema.parse>;

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validColumnValue(value: unknown, column: TableDocument['columns'][number]): boolean {
  if (value === null) return column.nullable;

  let valid = false;
  if (column.type === 'string') valid = typeof value === 'string';
  else if (column.type === 'integer') valid = typeof value === 'number' && Number.isInteger(value);
  else if (column.type === 'number') valid = typeof value === 'number' && Number.isFinite(value);
  else if (column.type === 'boolean') valid = typeof value === 'boolean';
  else if (column.type === 'date') valid = typeof value === 'string' && validDate(value);
  else if (column.type === 'datetime') {
    valid =
      typeof value === 'string' &&
      /(Z|[+-]\d{2}:\d{2})$/.test(value) &&
      !Number.isNaN(Date.parse(value));
  } else if (column.type === 'url') {
    try {
      const url = new URL(String(value));
      valid = typeof value === 'string' && (url.protocol === 'http:' || url.protocol === 'https:');
    } catch {
      valid = false;
    }
  } else if (column.type === 'enum') {
    valid = typeof value === 'string' && (column.values ?? []).includes(value);
  }

  if (!valid) return false;
  if (typeof value === 'number' && column.minimum !== undefined && value < column.minimum) return false;
  if (typeof value === 'number' && column.maximum !== undefined && value > column.maximum) return false;
  if (typeof value === 'string' && column.pattern !== undefined) {
    try {
      if (!new RegExp(column.pattern).test(value)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function validateRecordData(schema: TableDocument, data: Record<string, unknown>): void {
  const expected = schema.columns.map((column) => column.name).sort();
  if (canonicalJson(Object.keys(data).sort()) !== canonicalJson(expected)) {
    throw new DomainError('Record columns do not match the registered schema', 'schema_validation_failed', 400);
  }
  for (const column of schema.columns) {
    if (!validColumnValue(data[column.name], column)) {
      throw new DomainError(`Record column '${column.name}' is invalid`, 'schema_validation_failed', 400);
    }
  }
}

function recordDedupeKey(schema: TableDocument, data: Record<string, unknown>): string {
  const values = schema.table.primary_key.map((name) => data[name]);
  return values.length === 1 ? String(values[0]) : canonicalJson(values);
}

type PendingQuestionRegistration = {
  taskId: string | null;
  runId?: string | null;
  gateKind: AgentQuestion['gate_kind'];
  questionTurnId: string;
  questionEventId: string;
  toolCallId: string;
  threadId: string;
  questionText: string;
  options: string[];
};

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

  savePendingQuestion(workbookId: string, input: PendingQuestionRegistration) {
    const workbook = this.getWorkbook(workbookId);
    if (input.taskId) {
      const task = this.database
        .prepare('SELECT workbook_id FROM tasks WHERE id = ?')
        .get(input.taskId) as { workbook_id: string } | undefined;
      if (!task || task.workbook_id !== workbook.id) {
        throw new DomainError('Question task does not belong to this workbook', 'question_task_mismatch', 409);
      }
    }

    const existingRow = this.database
      .prepare('SELECT * FROM agent_questions WHERE workbook_id = ? AND tool_call_id = ?')
      .get(workbook.id, input.toolCallId);
    if (existingRow) {
      const existing = this.parseAgentQuestion(existingRow);
      if (
        existing.question_event_id !== input.questionEventId ||
        existing.question_turn_id !== input.questionTurnId
      ) {
        throw new DomainError('Question tool call is already linked to another action', 'question_identity_conflict', 409);
      }
      return existing;
    }

    const timestamp = new Date().toISOString();
    const question = AgentQuestionSchema.parse({
      id: `question_${randomUUID()}`,
      workbook_id: workbook.id,
      task_id: input.taskId,
      run_id: input.runId ?? null,
      gate_kind: input.gateKind,
      question_turn_id: input.questionTurnId,
      question_event_id: input.questionEventId,
      tool_call_id: input.toolCallId,
      thread_id: input.threadId,
      question_text: input.questionText,
      options: input.options,
      status: 'pending',
      answer_text: null,
      decision: null,
      answer_turn_id: null,
      created_at: timestamp,
      answered_at: null,
    });

    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO agent_questions(
             id, workbook_id, task_id, run_id, gate_kind, question_turn_id, question_event_id,
             tool_call_id, thread_id, question_text, options_json, status, answer_text, decision,
             answer_turn_id, created_at, answered_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          question.id,
          question.workbook_id,
          question.task_id,
          question.run_id,
          question.gate_kind,
          question.question_turn_id,
          question.question_event_id,
          question.tool_call_id,
          question.thread_id,
          question.question_text,
          JSON.stringify(question.options),
          question.status,
          question.answer_text,
          question.decision,
          question.answer_turn_id,
          question.created_at,
          question.answered_at,
        );
      this.database
        .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(
          workbook.id,
          'agent.question_pending',
          JSON.stringify({
            question_id: question.id,
            task_id: question.task_id,
            gate_kind: question.gate_kind,
            question_event_id: question.question_event_id,
          }),
          timestamp,
        );
    })();

    return question;
  }

  getPendingQuestion(workbookId: string): AgentQuestion | null {
    this.getWorkbook(workbookId);
    const row = this.database
      .prepare(
        `SELECT * FROM agent_questions
         WHERE workbook_id = ? AND status IN ('pending', 'submitting')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(workbookId);
    return row ? this.parseAgentQuestion(row) : null;
  }

  markQuestionSubmitting(workbookId: string, toolCallId: string, input: AnswerQuestionInput) {
    const question = this.questionForAnswer(workbookId, toolCallId, input);
    if (question.status === 'submitting') {
      throw new DomainError('Question answer is already being submitted', 'question_submission_in_progress', 409, true);
    }
    if (question.status !== 'pending') {
      throw new DomainError('Question is no longer pending', 'question_not_pending', 409);
    }
    this.resolveQuestionTransition(question, input);

    this.database
      .prepare('UPDATE agent_questions SET status = ? WHERE id = ? AND status = ?')
      .run('submitting', question.id, 'pending');
    return this.getQuestion(question.id);
  }

  resetQuestionSubmission(workbookId: string, toolCallId: string) {
    const question = this.database
      .prepare('SELECT * FROM agent_questions WHERE workbook_id = ? AND tool_call_id = ?')
      .get(workbookId, toolCallId);
    if (question) {
      this.database
        .prepare("UPDATE agent_questions SET status = 'pending' WHERE id = ? AND status = 'submitting'")
        .run((question as { id: string }).id);
    }
  }

  completeQuestion(
    workbookId: string,
    toolCallId: string,
    input: AnswerQuestionInput,
    answerTurnId: string,
  ) {
    const question = this.questionForAnswer(workbookId, toolCallId, input);
    if (question.status === 'answered') {
      if (question.answer_turn_id === answerTurnId && question.answer_text === input.answer) {
        return question;
      }
      throw new DomainError('Question has already been answered', 'question_already_answered', 409);
    }
    if (question.status !== 'submitting') {
      throw new DomainError('Question is not being submitted', 'question_not_submitting', 409);
    }

    const { task, run, nextState } = this.resolveQuestionTransition(question, input);
    const timestamp = new Date().toISOString();
    const approval =
      question.gate_kind === 'production_review' && input.decision === 'approve' && task && run
        ? ApprovalEventSchema.parse({
            id: `approval_${randomUUID()}`,
            workbook_id: workbookId,
            task_id: task.id,
            run_id: run.id,
            agent_question_id: question.id,
            question_event_id: question.question_event_id,
            tool_call_id: question.tool_call_id,
            question_turn_id: question.question_turn_id,
            answer_turn_id: answerTurnId,
            answer_text: input.answer,
            approved_task_hash: run.task_hash,
            approved_schema_hash: run.schema_hash,
            approved_pipeline_hash: run.pipeline_hash,
            created_at: timestamp,
          })
        : null;
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE agent_questions
           SET status = 'answered', answer_text = ?, decision = ?, answer_turn_id = ?, answered_at = ?
           WHERE id = ? AND status = 'submitting'`,
        )
        .run(input.answer, input.decision, answerTurnId, timestamp, question.id);
      if (approval) {
        this.database
          .prepare(
            `INSERT INTO approval_events(
               id, workbook_id, task_id, run_id, agent_question_id, question_event_id,
               tool_call_id, question_turn_id, answer_turn_id, answer_text,
               approved_task_hash, approved_schema_hash, approved_pipeline_hash, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            approval.id,
            approval.workbook_id,
            approval.task_id,
            approval.run_id,
            approval.agent_question_id,
            approval.question_event_id,
            approval.tool_call_id,
            approval.question_turn_id,
            approval.answer_turn_id,
            approval.answer_text,
            approval.approved_task_hash,
            approval.approved_schema_hash,
            approval.approved_pipeline_hash,
            approval.created_at,
          );
        this.database
          .prepare(
            `UPDATE runs
             SET status = 'authorized', approved_at = ?, approval_event_id = ?,
                 approved_task_hash = ?, approved_schema_hash = ?, approved_pipeline_hash = ?,
                 updated_at = ?
             WHERE id = ? AND status = 'awaiting_confirmation'`,
          )
          .run(
            timestamp,
            approval.id,
            approval.approved_task_hash,
            approval.approved_schema_hash,
            approval.approved_pipeline_hash,
            timestamp,
            approval.run_id,
          );
      } else if (question.gate_kind === 'production_review' && run) {
        this.database
          .prepare(
            `UPDATE runs
             SET status = 'cancelled', finished_at = ?, updated_at = ?
             WHERE id = ? AND status = 'awaiting_confirmation'`,
          )
          .run(timestamp, timestamp, run.id);
      }
      if (task && nextState) {
        this.database
          .prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?')
          .run(nextState, timestamp, task.id);
      }
      this.database
        .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(
          workbookId,
          'agent.question_answered',
          JSON.stringify({
            question_id: question.id,
            task_id: question.task_id,
            gate_kind: question.gate_kind,
            decision: input.decision,
            answer_turn_id: answerTurnId,
            run_id: run?.id ?? null,
            approval_event_id: approval?.id ?? null,
            next_task_state: nextState,
          }),
          timestamp,
        );
    })();

    return this.getQuestion(question.id);
  }

  private resolveQuestionTransition(question: AgentQuestion, input: AnswerQuestionInput) {
    const task = question.task_id
      ? TaskSchema.parse(this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(question.task_id))
      : null;
    const run = question.run_id
      ? this.parseRun(this.database.prepare('SELECT * FROM runs WHERE id = ?').get(question.run_id))
      : null;
    let nextState: Task['state'] | null = null;
    if (question.gate_kind === 'task_review') {
      if (!task) throw new DomainError('Task review question is missing its task', 'question_task_missing', 409);
      if (input.decision === 'approve') nextState = 'exploring';
      else if (input.decision === 'revise') nextState = 'aligning';
      else if (input.decision === 'cancel') nextState = 'cancelled';
      else throw new DomainError('Task review requires approve, revise, or cancel', 'invalid_question_decision', 400);
    } else if (question.gate_kind === 'schema_review') {
      if (!task) throw new DomainError('Schema review question is missing its task', 'question_task_missing', 409);
      if (input.decision === 'approve') nextState = 'building';
      else if (input.decision === 'revise') nextState = 'exploring';
      else if (input.decision === 'cancel') nextState = 'cancelled';
      else throw new DomainError('Schema review requires approve, revise, or cancel', 'invalid_question_decision', 400);
    } else if (question.gate_kind === 'production_review') {
      if (!task || !run) {
        throw new DomainError('Production review is missing its task or run', 'question_run_missing', 409);
      }
      if (run.task_id !== task.id || run.mode !== 'production' || run.status !== 'awaiting_confirmation') {
        throw new DomainError('Production review does not match an awaiting run', 'question_run_mismatch', 409);
      }
      if (input.decision === 'approve') nextState = 'production_running';
      else if (input.decision === 'revise') nextState = 'building';
      else if (input.decision === 'cancel') nextState = 'cancelled';
      else throw new DomainError('Production review requires approve, revise, or cancel', 'invalid_question_decision', 400);
    } else if (question.gate_kind === 'clarification') {
      if (input.decision !== 'free_text') {
        throw new DomainError('Clarification requires a free-text decision', 'invalid_question_decision', 400);
      }
    } else {
      throw new DomainError('This question gate is not implemented in the current slice', 'unsupported_question_gate', 409);
    }

    if (task && nextState && !canTransitionTask(task.state, nextState)) {
      throw new DomainError(`Task cannot move from '${task.state}' to '${nextState}'`, 'invalid_task_state', 409);
    }
    return { task, run, nextState };
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

    const taskTables = task ? snapshot.tables.filter(table => table.task_id === task.id) : [];
    const taskRuns = task ? snapshot.runs.filter(run => run.task_id === task.id) : [];

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
      tables: taskTables.map((table) => ({
        id: table.id,
        slug: table.slug,
        kind: table.kind,
        schema_hash: table.schema_hash,
      })),
      aggregate_schema_hash: aggregateSchemaHash(taskTables),
      runs: taskRuns.map((run) => ({
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
      const table = item.schema.table;
      if (item.path !== `schemas/${table.slug}.yaml`) {
        throw new DomainError(`Schema '${item.path}' has invalid table metadata`, 'schema_validation_failed', 400);
      }
      if (seenSlugs.has(table.slug)) {
        throw new DomainError(`Table slug '${table.slug}' is duplicated`, 'schema_set_invalid', 400);
      }
      seenSlugs.add(table.slug);

      const actualHash = hashJson(item.schema);
      if (actualHash !== item.schema_hash) {
        throw new DomainError(`schema_hash does not match '${item.path}'`, 'schema_hash_mismatch', 400);
      }

      return TableSchema.parse({
        id: `table_${randomUUID()}`,
        task_id: task.id,
        slug: table.slug,
        name: table.name,
        kind: table.kind,
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

  getProductionAuthorization(input: ProductionAuthorizationInput) {
    const requested = ProductionAuthorizationInputSchema.parse(input);
    const runRow = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(requested.run_id);
    if (!runRow) throw new DomainError(`Run '${requested.run_id}' was not found`, 'run_not_found', 404);
    const run = this.parseRun(runRow);
    const hashes = {
      task: requested.task_hash,
      schema: requested.schema_hash,
      pipeline: requested.pipeline_hash,
    };
    const denied = (reason: string) => ({
      authorized: false,
      reason,
      run_id: run.id,
      approved_at: null,
      approval_event_id: null,
      hashes,
    });

    if (run.mode !== 'production') return denied('run_not_production');
    if (run.status === 'awaiting_confirmation') return denied('awaiting_explicit_consent');
    if (!['authorized', 'running', 'finalizing'].includes(run.status)) return denied('run_not_active');
    if (
      !run.approved_at ||
      !run.approval_event_id ||
      !run.approved_task_hash ||
      !run.approved_schema_hash ||
      !run.approved_pipeline_hash
    ) {
      return denied('approval_evidence_missing');
    }

    const taskRow = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(run.task_id);
    if (!taskRow) throw new DomainError(`Task '${run.task_id}' was not found`, 'task_not_found', 404);
    const task = TaskSchema.parse(taskRow);
    const tables = this.database
      .prepare('SELECT * FROM tables WHERE task_id = ? ORDER BY ordinal')
      .all(task.id)
      .map((table) => this.parseTable(table));
    const approval = this.database
      .prepare('SELECT * FROM approval_events WHERE id = ? AND run_id = ?')
      .get(run.approval_event_id, run.id) as Record<string, unknown> | undefined;

    if (!approval) return denied('approval_evidence_missing');
    if (
      run.task_hash !== requested.task_hash ||
      run.schema_hash !== requested.schema_hash ||
      run.pipeline_hash !== requested.pipeline_hash ||
      task.task_hash !== requested.task_hash ||
      aggregateSchemaHash(tables) !== requested.schema_hash ||
      run.approved_task_hash !== requested.task_hash ||
      run.approved_schema_hash !== requested.schema_hash ||
      run.approved_pipeline_hash !== requested.pipeline_hash ||
      approval.approved_task_hash !== requested.task_hash ||
      approval.approved_schema_hash !== requested.schema_hash ||
      approval.approved_pipeline_hash !== requested.pipeline_hash
    ) {
      return denied('approval_hash_mismatch');
    }

    return {
      authorized: true,
      reason: 'authorized',
      run_id: run.id,
      approved_at: run.approved_at,
      approval_event_id: run.approval_event_id,
      hashes,
    };
  }

  publishBatch(input: PublishBatchInput) {
    const requested = PublishBatchInputSchema.parse(input);
    const payloadHash = hashJson({
      run_id: requested.run_id,
      table_slug: requested.table_slug,
      batch_key: requested.batch_key,
      records: requested.records,
    });
    if (payloadHash !== requested.payload_hash) {
      throw new DomainError('payload_hash does not match records', 'payload_hash_mismatch', 400);
    }

    const publish = this.database.transaction(() => {
      const runRow = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(requested.run_id);
      if (!runRow) throw new DomainError(`Run '${requested.run_id}' was not found`, 'run_not_found', 404);
      const run = this.parseRun(runRow);
      const taskRow = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(run.task_id);
      if (!taskRow) throw new DomainError(`Task '${run.task_id}' was not found`, 'task_not_found', 404);
      const task = TaskSchema.parse(taskRow);
      const tableRow = this.database
        .prepare('SELECT * FROM tables WHERE task_id = ? AND slug = ?')
        .get(task.id, requested.table_slug);
      if (!tableRow) {
        throw new DomainError(`Table '${requested.table_slug}' was not found`, 'table_not_found', 404);
      }
      const table = this.parseTable(tableRow);
      const existingRow = this.database
        .prepare('SELECT * FROM run_batches WHERE run_id = ? AND table_id = ? AND batch_key = ?')
        .get(run.id, table.id, requested.batch_key);
      if (existingRow) {
        const existing = RunBatchSchema.parse(existingRow);
        if (existing.payload_hash !== payloadHash) {
          throw new DomainError('Batch key already has a different payload', 'batch_key_conflict', 409);
        }
        return {
          run_id: run.id,
          table_slug: table.slug,
          batch_key: existing.batch_key,
          payload_hash: existing.payload_hash,
          replayed: true,
          processed: existing.row_count,
          inserted: existing.inserted_count,
          duplicates: existing.duplicate_count,
          published_row_count: existing.published_row_count_after,
        };
      }

      if (run.mode !== 'production') {
        throw new DomainError('Test runs cannot publish formal rows', 'test_publish_forbidden', 409);
      }
      if (!['authorized', 'running'].includes(run.status) || task.state !== 'production_running') {
        throw new DomainError('Production run is not accepting batches', 'invalid_run_state', 409);
      }
      const authorization = this.getProductionAuthorization({
        run_id: run.id,
        task_hash: requested.task_hash,
        schema_hash: requested.schema_hash,
        pipeline_hash: requested.pipeline_hash,
      });
      if (!authorization.authorized) {
        const code = authorization.reason === 'approval_hash_mismatch' ? 'approval_hash_mismatch' : 'production_not_authorized';
        throw new DomainError('Production authorization is not current', code, 409);
      }

      const schema = TableSchemaDocumentSchema.parse(table.schema);
      const seen = new Set<string>();
      const rows = requested.records.map((record) => {
        validateRecordData(schema, record.data);
        if (record.dedupe_key !== recordDedupeKey(schema, record.data)) {
          throw new DomainError('Record dedupe key does not match its primary key', 'schema_validation_failed', 400);
        }
        if (seen.has(record.dedupe_key)) {
          throw new DomainError('Batch contains a duplicate dedupe key', 'duplicate_dedupe_key', 409);
        }
        seen.add(record.dedupe_key);
        if (
          (table.kind === 'source' && record.provenance.kind !== 'direct') ||
          (table.kind === 'derived' && record.provenance.kind !== 'derived')
        ) {
          throw new DomainError('Record provenance does not match the table kind', 'schema_validation_failed', 400);
        }
        for (const parent of record.provenance.parents) {
          const parentRow = this.database
            .prepare(
              `SELECT 1 FROM table_rows
               JOIN tables ON tables.id = table_rows.table_id
               WHERE tables.task_id = ? AND tables.slug = ?
                 AND table_rows.run_id = ? AND table_rows.dedupe_key = ?`,
            )
            .get(task.id, parent.table_slug, run.id, parent.dedupe_key);
          if (!parentRow) {
            throw new DomainError('Derived provenance parent was not published', 'schema_validation_failed', 400);
          }
        }

        const envelopeHash = hashJson({ data: record.data, provenance: record.provenance });
        const existing = this.database
          .prepare('SELECT envelope_hash FROM table_rows WHERE table_id = ? AND run_id = ? AND dedupe_key = ?')
          .get(table.id, run.id, record.dedupe_key) as { envelope_hash: string } | undefined;
        if (existing && existing.envelope_hash !== envelopeHash) {
          throw new DomainError('Existing row has different content', 'row_identity_conflict', 409);
        }
        return { record, envelopeHash, duplicate: Boolean(existing) };
      });

      const insertedCount = rows.filter((row) => !row.duplicate).length;
      const duplicateCount = rows.length - insertedCount;
      const publishedRowCount = run.published_row_count + insertedCount;
      const timestamp = new Date().toISOString();
      const batch = RunBatchSchema.parse({
        id: `batch_${randomUUID()}`,
        run_id: run.id,
        table_id: table.id,
        batch_key: requested.batch_key,
        payload_hash: payloadHash,
        row_count: rows.length,
        inserted_count: insertedCount,
        duplicate_count: duplicateCount,
        published_row_count_after: publishedRowCount,
        created_at: timestamp,
      });
      this.database
        .prepare(
          `INSERT INTO run_batches(
             id, run_id, table_id, batch_key, payload_hash, row_count, inserted_count,
             duplicate_count, published_row_count_after, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          batch.id,
          batch.run_id,
          batch.table_id,
          batch.batch_key,
          batch.payload_hash,
          batch.row_count,
          batch.inserted_count,
          batch.duplicate_count,
          batch.published_row_count_after,
          batch.created_at,
        );
      const insertRow = this.database.prepare(
        `INSERT INTO table_rows(
           id, table_id, run_id, batch_id, dedupe_key, data_json,
           provenance_json, envelope_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        if (row.duplicate) continue;
        const stored = TableRowSchema.parse({
          id: `row_${randomUUID()}`,
          table_id: table.id,
          run_id: run.id,
          batch_id: batch.id,
          dedupe_key: row.record.dedupe_key,
          data: row.record.data,
          provenance: row.record.provenance,
          envelope_hash: row.envelopeHash,
          created_at: timestamp,
        });
        insertRow.run(
          stored.id,
          stored.table_id,
          stored.run_id,
          stored.batch_id,
          stored.dedupe_key,
          canonicalJson(stored.data),
          canonicalJson(stored.provenance),
          stored.envelope_hash,
          stored.created_at,
        );
      }
      this.database
        .prepare(
          `UPDATE runs
           SET status = 'running', published_row_count = ?, started_at = COALESCE(started_at, ?), updated_at = ?
           WHERE id = ?`,
        )
        .run(publishedRowCount, timestamp, timestamp, run.id);
      this.database
        .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(
          task.workbook_id,
          'table.batch_published',
          JSON.stringify({
            run_id: run.id,
            table_id: table.id,
            table_slug: table.slug,
            batch_key: batch.batch_key,
            inserted: insertedCount,
            duplicates: duplicateCount,
            published_row_count: publishedRowCount,
          }),
          timestamp,
        );

      return {
        run_id: run.id,
        table_slug: table.slug,
        batch_key: batch.batch_key,
        payload_hash: batch.payload_hash,
        replayed: false,
        processed: batch.row_count,
        inserted: insertedCount,
        duplicates: duplicateCount,
        published_row_count: publishedRowCount,
      };
    });

    return publish.immediate();
  }

  recordArtifact(input: RecordArtifactInput) {
    const requested = RecordArtifactInputSchema.parse(input);
    if (!requested.path.startsWith('artifacts/')) {
      throw new DomainError('Artifacts must be stored under artifacts/', 'artifact_path_invalid', 400);
    }
    const scan = requested.metadata.scan;
    if (!scan || typeof scan !== 'object' || Array.isArray(scan) || scan.status !== 'passed') {
      throw new DomainError('Artifact requires a passed scan result', 'artifact_scan_required', 400);
    }

    const record = this.database.transaction(() => {
      const runRow = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(requested.run_id);
      if (!runRow) throw new DomainError(`Run '${requested.run_id}' was not found`, 'run_not_found', 404);
      const run = this.parseRun(runRow);
      const taskRow = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(run.task_id);
      if (!taskRow) throw new DomainError(`Task '${run.task_id}' was not found`, 'task_not_found', 404);
      const task = TaskSchema.parse(taskRow);
      const existingRow = this.database.prepare('SELECT * FROM artifacts WHERE run_id = ? AND path = ?').get(run.id, requested.path);
      if (existingRow) {
        const existing = this.parseArtifact(existingRow);
        if (existing.sha256 !== requested.sha256) {
          throw new DomainError('Artifact path already has different content', 'artifact_identity_conflict', 409);
        }
        return { ...existing, download_available: true };
      }

      if (
        run.task_hash !== requested.task_hash ||
        run.schema_hash !== requested.schema_hash ||
        run.pipeline_hash !== requested.pipeline_hash
      ) {
        throw new DomainError('Artifact hashes do not match the run', 'approval_hash_mismatch', 409);
      }
      const turn = this.database
        .prepare('SELECT 1 FROM trueforge_turns WHERE id = ? AND workbook_id = ?')
        .get(requested.trueforge_turn_id, task.workbook_id);
      if (!turn) throw new DomainError('Artifact turn does not belong to the workbook', 'turn_not_in_workbook', 409);

      if (run.mode === 'production') {
        if (!['running', 'finalizing'].includes(run.status)) {
          throw new DomainError('Production run is not ready for artifacts', 'invalid_run_state', 409);
        }
        const authorization = this.getProductionAuthorization({
          run_id: run.id,
          task_hash: requested.task_hash,
          schema_hash: requested.schema_hash,
          pipeline_hash: requested.pipeline_hash,
        });
        if (!authorization.authorized) {
          const code = authorization.reason === 'approval_hash_mismatch' ? 'approval_hash_mismatch' : 'production_not_authorized';
          throw new DomainError('Production authorization is not current', code, 409);
        }
        const incompleteTable = this.database
          .prepare(
            `SELECT tables.slug FROM tables
             LEFT JOIN table_rows ON table_rows.table_id = tables.id AND table_rows.run_id = ?
             WHERE tables.task_id = ?
             GROUP BY tables.id HAVING count(table_rows.id) = 0 LIMIT 1`,
          )
          .get(run.id, task.id);
        if (incompleteTable) {
          throw new DomainError('Formal tables are not fully published', 'run_completion_incomplete', 409);
        }
      }

      const timestamp = new Date().toISOString();
      const artifact = ArtifactSchema.parse({
        id: `artifact_${randomUUID()}`,
        run_id: run.id,
        trueforge_turn_id: requested.trueforge_turn_id,
        kind: requested.kind,
        path: requested.path,
        sha256: requested.sha256,
        size_bytes: requested.size_bytes,
        mime_type: requested.mime_type,
        metadata: requested.metadata,
        created_at: timestamp,
      });
      this.database
        .prepare(
          `INSERT INTO artifacts(
             id, run_id, trueforge_turn_id, kind, path, sha256, size_bytes,
             mime_type, metadata_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifact.id,
          artifact.run_id,
          artifact.trueforge_turn_id,
          artifact.kind,
          artifact.path,
          artifact.sha256,
          artifact.size_bytes,
          artifact.mime_type,
          canonicalJson(artifact.metadata),
          artifact.created_at,
        );
      if (run.mode === 'production' && run.status === 'running') {
        this.database.prepare("UPDATE runs SET status = 'finalizing', updated_at = ? WHERE id = ?").run(timestamp, run.id);
        this.database.prepare("UPDATE tasks SET state = 'finalizing', updated_at = ? WHERE id = ?").run(timestamp, task.id);
      }
      this.database
        .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(
          task.workbook_id,
          'artifact.recorded',
          JSON.stringify({ artifact_id: artifact.id, run_id: run.id, kind: artifact.kind, path: artifact.path }),
          timestamp,
        );
      return { ...artifact, download_available: true };
    });

    return record.immediate();
  }

  completeRun(input: CompleteRunInput) {
    const requested = CompleteRunInputSchema.parse(input);
    const runRow = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(requested.run_id);
    if (!runRow) throw new DomainError(`Run '${requested.run_id}' was not found`, 'run_not_found', 404);

    const run = this.parseRun(runRow);
    const taskRow = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(run.task_id);
    if (!taskRow) throw new DomainError(`Task '${run.task_id}' was not found`, 'task_not_found', 404);
    const task = TaskSchema.parse(taskRow);
    const tables = this.database
      .prepare('SELECT * FROM tables WHERE task_id = ? ORDER BY ordinal')
      .all(task.id)
      .map((table) => this.parseTable(table));

    if (
      requested.task_hash !== run.task_hash ||
      requested.schema_hash !== run.schema_hash ||
      requested.pipeline_hash !== run.pipeline_hash ||
      task.task_hash !== run.task_hash ||
      aggregateSchemaHash(tables) !== run.schema_hash
    ) {
      throw new DomainError('Run hashes do not match the current task and schemas', 'hashes_not_current', 409);
    }
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      if (
        run.status === requested.outcome &&
        canonicalJson(run.test_manifest) === canonicalJson(requested.manifest) &&
        canonicalJson(run.test_samples) === canonicalJson(requested.samples) &&
        canonicalJson(run.error) === canonicalJson(requested.error)
      ) {
        return {
          run_id: run.id,
          mode: run.mode,
          status: run.status,
          task_state: task.state,
          counts: run.test_manifest?.counts ?? {},
          next_action:
            run.mode === 'test' && run.status === 'completed'
              ? 'ask_production_review'
              : run.mode === 'production' && run.status === 'completed'
                ? 'offer_skill_promotion'
                : 'none',
        };
      }
      throw new DomainError('Run already has a different terminal result', 'terminal_run_conflict', 409);
    }

    if (run.mode === 'production') {
      if (!['authorized', 'running', 'finalizing'].includes(run.status)) {
        throw new DomainError('Production run cannot complete from its current state', 'invalid_run_state', 409);
      }
      if (Object.keys(requested.samples).length !== 0) {
        throw new DomainError('Production completion cannot contain review samples', 'run_completion_incomplete', 409);
      }

      const countRows = this.database
        .prepare(
          `SELECT tables.slug, tables.kind, count(table_rows.id) AS count
           FROM tables
           LEFT JOIN table_rows ON table_rows.table_id = tables.id AND table_rows.run_id = ?
           WHERE tables.task_id = ?
           GROUP BY tables.id ORDER BY tables.ordinal`,
        )
        .all(run.id, task.id) as Array<{ slug: string; kind: 'source' | 'derived'; count: number }>;
      const tableCounts = Object.fromEntries(countRows.map((row) => [row.slug, row.count]));
      const totalRecords = countRows.reduce((sum, row) => sum + row.count, 0);
      const sourceRecords = countRows
        .filter((row) => row.kind === 'source')
        .reduce((sum, row) => sum + row.count, 0);
      const derivedRecords = totalRecords - sourceRecords;
      const artifactRows = this.database.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at').all(run.id);
      let nextTaskState: 'completed' | 'failed' | 'cancelled';

      if (requested.outcome === 'completed') {
        const authorization = this.getProductionAuthorization({
          run_id: run.id,
          task_hash: requested.task_hash,
          schema_hash: requested.schema_hash,
          pipeline_hash: requested.pipeline_hash,
        });
        const manifestCounts = requested.manifest.counts;
        const manifestTables = requested.manifest.tables;
        const topThreeCount = tableCounts['tesla-top-3'];
        if (
          !authorization.authorized ||
          run.status !== 'finalizing' ||
          task.state !== 'finalizing' ||
          requested.error !== null ||
          requested.manifest.ok !== true ||
          requested.manifest.command !== 'finalize' ||
          requested.manifest.run_id !== run.id ||
          requested.manifest.mode !== 'production' ||
          requested.manifest.state !== 'ready_to_finalize' ||
          requested.manifest.task_hash !== run.task_hash ||
          requested.manifest.schema_hash !== run.schema_hash ||
          requested.manifest.pipeline_hash !== run.pipeline_hash ||
          requested.manifest.done !== true ||
          requested.manifest.error !== null ||
          !manifestCounts ||
          typeof manifestCounts !== 'object' ||
          Array.isArray(manifestCounts) ||
          !manifestTables ||
          typeof manifestTables !== 'object' ||
          Array.isArray(manifestTables) ||
          canonicalJson(requested.table_counts) !== canonicalJson(tableCounts) ||
          run.published_row_count !== totalRecords ||
          sourceRecords === 0 ||
          (topThreeCount !== undefined && topThreeCount !== 3) ||
          artifactRows.length === 0
        ) {
          throw new DomainError('Production result is incomplete or stale', 'run_completion_incomplete', 409);
        }

        const counts = manifestCounts as Record<string, unknown>;
        const tableManifests = manifestTables as Record<string, unknown>;
        if (
          counts.source_records !== sourceRecords ||
          counts.derived_records !== derivedRecords ||
          counts.yahoo_timestamp_count !== sourceRecords ||
          canonicalJson(Object.keys(tableManifests).sort()) !== canonicalJson(Object.keys(tableCounts).sort()) ||
          countRows.some((row) => {
            const item = tableManifests[row.slug];
            return !item || typeof item !== 'object' || Array.isArray(item) || (item as Record<string, unknown>).count !== row.count;
          })
        ) {
          throw new DomainError('Production manifest does not match formal rows', 'run_completion_incomplete', 409);
        }
        nextTaskState = 'completed';
      } else if (requested.outcome === 'failed') {
        if (requested.error === null) {
          throw new DomainError('A failed run requires a portable error', 'run_completion_incomplete', 409);
        }
        nextTaskState = 'failed';
      } else {
        nextTaskState = 'cancelled';
      }

      const timestamp = new Date().toISOString();
      const finish = this.database.transaction(() => {
        this.database
          .prepare(
            `UPDATE runs
             SET status = ?, test_manifest_json = ?, test_samples_json = ?, total_record_count = ?,
                 error_json = ?, finished_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            requested.outcome,
            JSON.stringify(requested.manifest),
            JSON.stringify(requested.samples),
            totalRecords,
            requested.error ? JSON.stringify(requested.error) : null,
            timestamp,
            timestamp,
            run.id,
          );
        this.database
          .prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?')
          .run(nextTaskState, timestamp, task.id);
        this.database
          .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
          .run(
            task.workbook_id,
            `run.${requested.outcome}`,
            JSON.stringify({ run_id: run.id, task_state: nextTaskState, table_counts: tableCounts }),
            timestamp,
          );
      });
      finish.immediate();

      return {
        run_id: run.id,
        mode: run.mode,
        status: requested.outcome,
        task_state: nextTaskState,
        counts: tableCounts,
        artifact_ids: artifactRows.map((row) => this.parseArtifact(row).id),
        next_action: requested.outcome === 'completed' ? 'offer_skill_promotion' : 'none',
      };
    }

    if (run.status !== 'running' || task.state !== 'testing') {
      throw new DomainError(`Test run cannot complete while task is '${task.state}'`, 'invalid_task_state', 409);
    }

    let nextTaskState: 'awaiting_production_confirmation' | 'building' | 'cancelled';
    if (requested.outcome === 'completed') {
      const manifestCounts = requested.manifest.counts;
      const manifestTables = requested.manifest.tables;
      if (
        requested.error !== null ||
        requested.manifest.ok !== true ||
        requested.manifest.command !== 'test' ||
        requested.manifest.run_id !== run.id ||
        requested.manifest.mode !== 'test' ||
        requested.manifest.state !== 'ready_to_finalize' ||
        requested.manifest.task_hash !== run.task_hash ||
        requested.manifest.schema_hash !== run.schema_hash ||
        requested.manifest.pipeline_hash !== run.pipeline_hash ||
        requested.manifest.done !== true ||
        requested.manifest.error !== null ||
        !manifestCounts ||
        typeof manifestCounts !== 'object' ||
        Array.isArray(manifestCounts) ||
        !manifestTables ||
        typeof manifestTables !== 'object' ||
        Array.isArray(manifestTables)
      ) {
        throw new DomainError('Test manifest is incomplete or stale', 'run_completion_incomplete', 409);
      }

      const samples = requested.samples;
      const sampleSlugs = Object.keys(samples).sort();
      const tableSlugs = tables.map((table) => table.slug).sort();
      const counts = manifestCounts as Record<string, unknown>;
      const tableManifests = manifestTables as Record<string, unknown>;
      const manifestSlugs = Object.keys(tableManifests).sort();
      let sourceRecords = 0;
      let derivedRecords = 0;

      for (const table of tables) {
        const tableManifest = tableManifests[table.slug];
        if (!tableManifest || typeof tableManifest !== 'object' || Array.isArray(tableManifest)) {
          throw new DomainError('Test table manifest is incomplete', 'run_completion_incomplete', 409);
        }
        const recordCount = (tableManifest as Record<string, unknown>).count;
        if (!Number.isInteger(recordCount) || Number(recordCount) < 0) {
          throw new DomainError('Test table count is invalid', 'run_completion_incomplete', 409);
        }
        if ((samples[table.slug]?.length ?? 0) !== Math.min(Number(recordCount), MAX_TEST_SAMPLE_RECORDS_PER_TABLE)) {
          throw new DomainError('Test samples do not match table counts', 'run_completion_incomplete', 409);
        }
        if (table.kind === 'source') sourceRecords += Number(recordCount);
        else derivedRecords += Number(recordCount);
      }

      if (
        canonicalJson(sampleSlugs) !== canonicalJson(tableSlugs) ||
        canonicalJson(manifestSlugs) !== canonicalJson(tableSlugs) ||
        counts.source_records !== sourceRecords ||
        counts.derived_records !== derivedRecords ||
        sourceRecords !== 5
      ) {
        throw new DomainError('Test samples do not match the manifest', 'run_completion_incomplete', 409);
      }
      if (run.published_row_count !== 0 || Object.keys(requested.table_counts).length !== 0) {
        throw new DomainError('Test runs cannot contain formal rows', 'test_rows_contaminated', 409);
      }
      nextTaskState = 'awaiting_production_confirmation';
    } else if (requested.outcome === 'failed') {
      if (requested.error === null) {
        throw new DomainError('A failed run requires a portable error', 'run_completion_incomplete', 409);
      }
      nextTaskState = 'building';
    } else {
      nextTaskState = 'cancelled';
    }

    const timestamp = new Date().toISOString();
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE runs
           SET status = ?, test_manifest_json = ?, test_samples_json = ?, error_json = ?,
               finished_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          requested.outcome,
          JSON.stringify(requested.manifest),
          JSON.stringify(requested.samples),
          requested.error ? JSON.stringify(requested.error) : null,
          timestamp,
          timestamp,
          run.id,
        );
      this.database
        .prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?')
        .run(nextTaskState, timestamp, task.id);
      this.database
        .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(
          task.workbook_id,
          `run.${requested.outcome}`,
          JSON.stringify({ run_id: run.id, task_state: nextTaskState }),
          timestamp,
        );
    })();

    return {
      run_id: run.id,
      mode: run.mode,
      status: requested.outcome,
      task_state: nextTaskState,
      counts: requested.manifest.counts ?? {},
      next_action:
        requested.outcome === 'completed'
          ? 'ask_production_review'
          : requested.outcome === 'failed'
            ? 'revise_pipeline'
            : 'none',
    };
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
    const artifactRows = this.database
      .prepare(
        `SELECT artifacts.* FROM artifacts
         JOIN runs ON runs.id = artifacts.run_id
         JOIN tasks ON tasks.id = runs.task_id
         WHERE tasks.workbook_id = ? ORDER BY artifacts.created_at`,
      )
      .all(workbookId);
    const countRows = this.database
      .prepare(
        `SELECT tables.id, count(table_rows.id) AS count FROM tables
         JOIN tasks ON tasks.id = tables.task_id
         LEFT JOIN table_rows ON table_rows.table_id = tables.id
         WHERE tasks.workbook_id = ? GROUP BY tables.id`,
      )
      .all(workbookId) as Array<{ id: string; count: number }>;
    const pendingQuestionRow = this.database
      .prepare(
        `SELECT * FROM agent_questions
         WHERE workbook_id = ? AND status IN ('pending', 'submitting')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(workbookId);

    return WorkbookSnapshotSchema.parse({
      workbook: this.getWorkbook(workbookId),
      tasks: taskRows.map(row => TaskSchema.parse(row)),
      tables: tableRows.map((row) => this.parseTable(row)),
      runs: runRows.map((row) => this.parseRun(row)),
      pending_question: pendingQuestionRow ? this.parseAgentQuestion(pendingQuestionRow) : null,
      artifacts: artifactRows.map((row) => this.parseArtifact(row)),
      generated_skills: [],
      table_counts: Object.fromEntries(countRows.map((row) => [row.id, row.count])),
    });
  }

  private questionForAnswer(workbookId: string, toolCallId: string, input: AnswerQuestionInput) {
    const answer = AnswerQuestionInputSchema.parse(input);
    const row = this.database
      .prepare('SELECT * FROM agent_questions WHERE workbook_id = ? AND tool_call_id = ?')
      .get(workbookId, toolCallId);
    if (!row) {
      throw new DomainError('The requested question is not pending', 'question_not_found', 404);
    }
    const question = this.parseAgentQuestion(row);
    if (
      question.question_event_id !== answer.question_event_id ||
      question.question_turn_id !== answer.question_turn_id ||
      question.thread_id !== answer.thread_id ||
      question.gate_kind !== answer.gate_kind ||
      (answer.related_run_id !== undefined && question.run_id !== answer.related_run_id)
    ) {
      throw new DomainError('Question identifiers do not match the pending action', 'question_identity_mismatch', 409);
    }
    return question;
  }

  private getQuestion(id: string): AgentQuestion {
    const row = this.database.prepare('SELECT * FROM agent_questions WHERE id = ?').get(id);
    if (!row) throw new Error('Question was not persisted');
    return this.parseAgentQuestion(row);
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

  private parseAgentQuestion(row: unknown) {
    if (!row || typeof row !== 'object') throw new Error('Question was not persisted');
    const { options_json: optionsJson, ...stored } = row as Record<string, unknown>;
    return AgentQuestionSchema.parse({
      ...stored,
      options: JSON.parse(String(optionsJson)) as unknown,
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

  private parseArtifact(row: unknown) {
    if (!row || typeof row !== 'object') throw new Error('Artifact was not persisted');
    const { metadata_json: metadataJson, ...stored } = row as Record<string, unknown>;
    return ArtifactSchema.parse({
      ...stored,
      metadata: JSON.parse(String(metadataJson)) as unknown,
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
