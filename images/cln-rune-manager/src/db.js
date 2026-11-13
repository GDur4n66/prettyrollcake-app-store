// rune の unique_id ごとの名前・メモ（rune 本体は CLN が持っているので保存しない）
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runes (
      unique_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '',
      created_here INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const now = () => new Date().toISOString();
  const q = {
    get: db.prepare('SELECT * FROM runes WHERE unique_id = ?'),
    all: db.prepare('SELECT * FROM runes'),
    insert: db.prepare('INSERT INTO runes (unique_id, name, memo, created_here, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE runes SET name = ?, memo = ?, updated_at = ? WHERE unique_id = ?'),
  };
  return {
    close: () => db.close(),
    get: (id) => q.get.get(String(id)) ?? null,
    all: () => q.all.all(),
    /** 名前・メモを保存（記録がなければ作る） */
    upsert(id, { name, memo, createdHere = false }) {
      const cur = q.get.get(String(id));
      const t = now();
      if (!cur) q.insert.run(String(id), name ?? '', memo ?? '', createdHere ? 1 : 0, t, t);
      else q.update.run(name ?? cur.name, memo ?? cur.memo, t, String(id));
      return q.get.get(String(id));
    },
  };
}
