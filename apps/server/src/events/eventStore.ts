import type { JsonObject, WorkbookEvent } from '@kalki/contracts';
import type Database from 'better-sqlite3';

interface EventRow {
  seq: number;
  workbook_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

export class EventStore {
  constructor(private readonly db: Database.Database) {}

  append(workbookId: string, type: string, payload: JsonObject): WorkbookEvent {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .run(workbookId, type, JSON.stringify(payload), createdAt);
    return {
      seq: Number(result.lastInsertRowid),
      workbook_id: workbookId,
      type,
      payload,
      created_at: createdAt,
    };
  }

  appendTurnEvent(
    workbookId: string,
    turnId: string,
    upstreamSequence: number,
    type: string,
    payload: JsonObject,
  ): WorkbookEvent | null {
    return this.db.transaction(() => {
      const turn = this.db
        .prepare('SELECT last_sequence_number FROM trueforge_turns WHERE id = ? AND workbook_id = ?')
        .get(turnId, workbookId) as { last_sequence_number: number } | undefined;
      if (!turn) throw new Error(`TrueForge turn '${turnId}' is not stored for this workbook`);
      if (upstreamSequence <= turn.last_sequence_number) return null;

      const event = this.append(workbookId, type, payload);
      this.db
        .prepare('UPDATE trueforge_turns SET last_sequence_number = ?, updated_at = ? WHERE id = ?')
        .run(upstreamSequence, event.created_at, turnId);
      return event;
    })();
  }

  listAfter(workbookId: string, after: number, limit = 200): WorkbookEvent[] {
    const rows = this.db
      .prepare(
        `SELECT seq, workbook_id, type, payload_json, created_at
         FROM workbook_events
         WHERE workbook_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(workbookId, after, limit) as EventRow[];
    return rows.map(row => ({
      seq: row.seq,
      workbook_id: row.workbook_id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as JsonObject,
      created_at: row.created_at,
    }));
  }

  listHistory(workbookId: string): {
    events: WorkbookEvent[];
    cursor: number;
  } {
    const rows = this.db
      .prepare(
        `SELECT seq, workbook_id, type, payload_json, created_at
         FROM workbook_events
         WHERE workbook_id = ?
         ORDER BY seq ASC`,
      )
      .all(workbookId) as EventRow[];
    const history: WorkbookEvent[] = [];
    const deltas = new Map<
      string,
      {
        record: WorkbookEvent;
        event: JsonObject;
        calls: Map<string, JsonObject>;
      }
    >();

    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as JsonObject;
      if (row.type !== 'agent.model.message.delta') {
        history.push({
          seq: row.seq,
          workbook_id: row.workbook_id,
          type: row.type,
          payload,
          created_at: row.created_at,
        });
        continue;
      }

      const sourceEvent = payload.event;
      if (
        !sourceEvent ||
        typeof sourceEvent !== 'object' ||
        Array.isArray(sourceEvent)
      ) {
        continue;
      }
      const eventId =
        typeof sourceEvent.id === 'string' ? sourceEvent.id : String(row.seq);
      const turnId =
        typeof payload.turn_id === 'string' ? payload.turn_id : 'unknown';
      const key = `${turnId}:${eventId}`;
      let compact = deltas.get(key);
      if (!compact) {
        const event: JsonObject = {
          type: 'model.message.delta',
          id: eventId,
          ...(typeof sourceEvent.thread_id === 'string'
            ? { thread_id: sourceEvent.thread_id }
            : {}),
        };
        const record: WorkbookEvent = {
          seq: row.seq,
          workbook_id: row.workbook_id,
          type: row.type,
          payload: { ...payload, event },
          created_at: row.created_at,
        };
        compact = { record, event, calls: new Map() };
        deltas.set(key, compact);
      }

      if (typeof sourceEvent.content === 'string') {
        compact.event.content = `${compact.event.content ?? ''}${sourceEvent.content}`;
      }
      if (typeof sourceEvent.reasoning_content === 'string') {
        compact.event.reasoning_content = `${compact.event.reasoning_content ?? ''}${sourceEvent.reasoning_content}`;
      }

      if (Array.isArray(sourceEvent.tool_calls)) {
        for (const value of sourceEvent.tool_calls) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            continue;
          }
          const index = String(value.index ?? 0);
          const call = compact.calls.get(index) ?? { index: value.index ?? 0 };
          if (typeof value.id === 'string') call.id = value.id;
          if (typeof value.type === 'string') call.type = value.type;
          if (
            value.tool_info &&
            typeof value.tool_info === 'object' &&
            !Array.isArray(value.tool_info)
          ) {
            call.tool_info = value.tool_info;
          }
          if (
            value.function &&
            typeof value.function === 'object' &&
            !Array.isArray(value.function)
          ) {
            const current =
              call.function &&
              typeof call.function === 'object' &&
              !Array.isArray(call.function)
                ? call.function
                : {};
            if (typeof value.function.name === 'string') {
              current.name = value.function.name;
            }
            if (typeof value.function.arguments === 'string') {
              current.arguments = `${current.arguments ?? ''}${value.function.arguments}`;
            }
            call.function = current;
          }
          compact.calls.set(index, call);
        }
        compact.event.tool_calls = [...compact.calls.values()];
      }
    }

    history.push(...[...deltas.values()].map(({ record }) => record));
    return {
      events: history.sort((left, right) => left.seq - right.seq),
      cursor: rows.at(-1)?.seq ?? 0,
    };
  }
}
