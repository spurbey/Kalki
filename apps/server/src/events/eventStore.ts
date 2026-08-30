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
}
