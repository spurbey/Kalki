import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations } from './migrations.js';

export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('synchronous = NORMAL');
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');

  const applied = database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const record = database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)');

  for (const migration of migrations) {
    if (applied.get(migration.version)) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      record.run(migration.version, new Date().toISOString());
    })();
  }

  return database;
}
