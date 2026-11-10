// ルートキー ID ごとの名前・メモと、作った macaroon の記録（本体は保存しない）
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS root_keys (
      root_key_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS bakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root_key_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      permissions TEXT NOT NULL,
      caveats TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bakes_root ON bakes(root_key_id);
  `);

  const now = () => new Date().toISOString();
  const q = {
    getKey: db.prepare('SELECT * FROM root_keys WHERE root_key_id = ?'),
    allKeys: db.prepare('SELECT * FROM root_keys'),
    insertKey: db.prepare('INSERT INTO root_keys (root_key_id, name, memo, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
    updateKey: db.prepare('UPDATE root_keys SET name = ?, memo = ?, updated_at = ? WHERE root_key_id = ?'),
    reviveKey: db.prepare('UPDATE root_keys SET deleted_at = NULL, updated_at = ? WHERE root_key_id = ?'),
    deleteKey: db.prepare('UPDATE root_keys SET deleted_at = ?, updated_at = ? WHERE root_key_id = ?'),
    insertBake: db.prepare('INSERT INTO bakes (root_key_id, created_at, permissions, caveats, note, fingerprint) VALUES (?, ?, ?, ?, ?, ?)'),
    bakesOf: db.prepare('SELECT * FROM bakes WHERE root_key_id = ? ORDER BY id DESC'),
    allBakes: db.prepare('SELECT * FROM bakes ORDER BY id DESC'),
    bakeByFp: db.prepare('SELECT * FROM bakes WHERE fingerprint = ?'),
  };
  const bakeRow = (r) => r && { ...r, permissions: JSON.parse(r.permissions), caveats: JSON.parse(r.caveats) };

  return {
    close: () => db.close(),
    getKey: (id) => q.getKey.get(String(id)) ?? null,
    allKeys: () => q.allKeys.all(),
    /** 名前・メモを保存（記録がなければ作る） */
    upsertKey(id, { name, memo }) {
      const cur = q.getKey.get(String(id));
      const t = now();
      if (!cur) q.insertKey.run(String(id), name ?? '', memo ?? '', t, t);
      else q.updateKey.run(name ?? cur.name, memo ?? cur.memo, t, String(id));
      return q.getKey.get(String(id));
    },
    reviveKey: (id) => q.reviveKey.run(now(), String(id)),
    markDeleted: (id) => {
      const t = now();
      if (!q.getKey.get(String(id))) q.insertKey.run(String(id), '', '', t, t);
      q.deleteKey.run(t, t, String(id));
    },
    addBake: ({ rootKeyId, permissions, caveats, note, fingerprint }) =>
      q.insertBake.run(String(rootKeyId), now(), JSON.stringify(permissions), JSON.stringify(caveats), note ?? '', fingerprint),
    bakesOf: (id) => q.bakesOf.all(String(id)).map(bakeRow),
    allBakes: () => q.allBakes.all().map(bakeRow),
    bakeByFingerprint: (fp) => bakeRow(q.bakeByFp.get(fp)),
  };
}
