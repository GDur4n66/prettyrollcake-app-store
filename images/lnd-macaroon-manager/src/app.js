// HTTP のルーティングと各操作
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.js';
import { verifyPassword, createSessions, createLoginLimiter } from './auth.js';
import * as M from './macaroon.js';
import { scanMacaroonFiles } from './files.js';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ID_RE = /^(0|[1-9][0-9]{0,19})$/;
const UINT64_MAX = 18446744073709551615n;

function parseRootKeyId(v) {
  const s = String(v ?? '').trim();
  if (!ID_RE.test(s) || BigInt(s) > UINT64_MAX) throw new HttpError(400, 'ID は 0 以上の整数で入力してください');
  return s;
}

export function createApp({ config, lnd, db, publicDir = resolve(ROOT, 'public') }) {
  const sessions = createSessions({ hours: config.sessionHours });
  const limiter = createLoginLimiter();
  // アプリ自身の macaroon（後から現れることもあるので毎回読む）
  function own() {
    try {
      const info = M.inspect(lnd.ownMacaroonHex() ?? '');
      return { id: info.rootKeyId, fingerprint: info.fingerprint };
    } catch {
      return { id: null, fingerprint: null };
    }
  }

  let permCache = null;
  async function permissions() {
    if (!permCache || permCache.at < Date.now() - 10 * 60 * 1000) {
      permCache = { at: Date.now(), value: await lnd.listPermissions() };
    }
    return permCache.value;
  }

  /** LND の ID 一覧と記録を突き合わせる */
  async function state() {
    const lndIds = await lnd.listIds();
    const ownId = own().id;
    const inLnd = new Set(lndIds);
    for (const id of lndIds) {
      const k = db.getKey(id);
      if (k?.deleted_at) db.reviveKey(id); // 削除後に別の手段で同じ ID が作られた
    }
    const keys = new Map(db.allKeys().map((k) => [k.root_key_id, k]));
    const bakes = db.allBakes();
    const ids = [...new Set([...lndIds, ...keys.keys()])];
    ids.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    return {
      ownId,
      ids: ids.map((id) => {
        const k = keys.get(id);
        const mine = bakes.filter((b) => b.root_key_id === id);
        return {
          rootKeyId: id,
          name: k?.name ?? '',
          memo: k?.memo ?? '',
          inLnd: inLnd.has(id),
          deletedAt: k?.deleted_at ?? null,
          isDefault: id === '0',
          isOwn: id === ownId,
          bakes: mine,
        };
      }),
    };
  }

  function nextId(lndIds) {
    let max = 0n;
    for (const id of [...lndIds, ...db.allKeys().map((k) => k.root_key_id)]) {
      if (ID_RE.test(id) && BigInt(id) > max) max = BigInt(id);
    }
    return String(max + 1n);
  }

  function normalizePermissions(list, methodPerms) {
    if (!Array.isArray(list) || list.length === 0) throw new HttpError(400, '権限を1つ以上選んでください');
    const known = new Set();
    for (const v of Object.values(methodPerms)) for (const p of v.permissions || []) known.add(`${p.entity}:${p.action}`);
    const out = new Map();
    for (const p of list) {
      const entity = String(p?.entity ?? '');
      const action = String(p?.action ?? '');
      if (entity === 'uri') {
        if (!Object.hasOwn(methodPerms, action)) throw new HttpError(400, `不明な RPC です: ${action}`);
      } else if (!known.has(`${entity}:${action}`)) {
        throw new HttpError(400, `不明な権限です: ${entity}:${action}`);
      }
      out.set(`${entity}:${action}`, { entity, action });
    }
    return [...out.values()].sort((a, b) => (a.entity + a.action).localeCompare(b.entity + b.action));
  }

  async function bake(body) {
    const methodPerms = await permissions();
    const perms = normalizePermissions(body.permissions, methodPerms);
    const lndIds = await lnd.listIds();
    let rootKeyId;
    let isNew = false;
    if (body.rootKeyId === 'new' || body.rootKeyId === undefined || body.rootKeyId === '') {
      rootKeyId = nextId(lndIds);
      isNew = true;
    } else {
      rootKeyId = parseRootKeyId(body.rootKeyId);
      const rec = db.getKey(rootKeyId);
      if (!lndIds.includes(rootKeyId)) {
        if (rec?.deleted_at) throw new HttpError(400, `ID ${rootKeyId} は削除済みです。新しい ID で作ってください`);
        isNew = true;
      }
    }
    if (rootKeyId === '0') {
      throw new HttpError(400, 'ID 0 は LND の標準 ID で、削除（無効化）できません。別の ID で作ってください');
    }
    const name = String(body.name ?? '').trim().slice(0, 100);
    const memo = String(body.memo ?? '').trim().slice(0, 2000);
    if (isNew && !db.getKey(rootKeyId)?.name && !name) throw new HttpError(400, '新しい ID には名前を付けてください');

    let expiresAt = null;
    if (body.expiresAt) {
      const t = new Date(body.expiresAt);
      if (Number.isNaN(t.getTime())) throw new HttpError(400, '有効期限の日時が不正です');
      if (t <= new Date()) throw new HttpError(400, '有効期限が過去になっています');
      expiresAt = t.toISOString();
    }
    const ipAddress = String(body.ipAddress ?? '').trim() || null;
    const ipRange = String(body.ipRange ?? '').trim() || null;

    // 先に条件の形を確かめてから LND に作らせる（失敗して ID だけ残るのを避ける）
    const dummy = M.serialize({ location: '', identifier: Buffer.from([3]), caveats: [], signature: Buffer.alloc(32) });
    try {
      M.constrain(dummy, { expiresAt, ipAddress, ipRange });
    } catch (e) {
      throw new HttpError(400, e.message);
    }

    const baseHex = await lnd.bake({ rootKeyId, permissions: perms });
    const finalBytes = M.constrain(baseHex, { expiresAt, ipAddress, ipRange });
    const info = M.inspect(finalBytes);

    if (name || memo || !db.getKey(rootKeyId)) db.upsertKey(rootKeyId, { name: name || undefined, memo: memo || undefined });
    db.reviveKey(rootKeyId);
    db.addBake({
      rootKeyId,
      permissions: perms,
      caveats: info.caveats,
      note: String(body.note ?? '').trim().slice(0, 200),
      fingerprint: info.fingerprint,
    });
    return {
      rootKeyId,
      isNew,
      macaroonHex: finalBytes.toString('hex'),
      macaroonBase64: finalBytes.toString('base64'),
      fingerprint: info.fingerprint,
      caveats: info.caveats,
      permissions: perms,
    };
  }

  /** macaroon のバイト列を読んで、権限・呼べる RPC・LND での有効性・記録をまとめる */
  async function analyze(bytes, info, methodPerms, lndIds) {
    const methods = M.allowedMethods(info.ops, methodPerms);
    let check = { valid: null, reason: '' };
    const firstOp = info.ops.find((o) => o.actions.length > 0);
    const hasIpLock = info.caveats.some((c) => c.kind === 'ip' || c.kind === 'iprange');
    if (!lndIds.includes(info.rootKeyId)) {
      check = { valid: false, reason: 'この ID は LND にありません（削除済み、または別のノードの macaroon）' };
    } else if (firstOp) {
      try {
        const perm = { entity: firstOp.entity, action: firstOp.actions[0] };
        const valid = await lnd.checkPermissions({
          macaroonBytes: bytes,
          permissions: [perm],
          fullMethod: perm.entity === 'uri' ? perm.action : '/lnrpc.Lightning/GetInfo',
        });
        check = { valid, reason: valid ? '' : 'LND が受け付けませんでした' };
      } catch (e) {
        check = hasIpLock && /ip/i.test(e.message)
          ? { valid: null, reason: 'IP 制限付きのため、このアプリからは有効かどうか確かめられません（署名・期限・権限は問題ありません）' }
          : { valid: false, reason: `LND が受け付けませんでした: ${e.message}` };
      }
    }
    const rec = db.getKey(info.rootKeyId);
    return {
      ...info,
      methods,
      methodCount: Object.keys(methodPerms).length,
      inLnd: lndIds.includes(info.rootKeyId),
      record: rec && { name: rec.name, memo: rec.memo, deletedAt: rec.deleted_at },
      bake: db.bakeByFingerprint(info.fingerprint),
      check,
    };
  }

  async function inspect(body) {
    let info;
    let bytes;
    try {
      bytes = M.toBytes(body.macaroon ?? '');
      info = M.inspect(bytes);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    const [methodPerms, lndIds] = await Promise.all([permissions(), lnd.listIds()]);
    return analyze(bytes, info, methodPerms, lndIds);
  }

  /** LND のフォルダにある macaroon ファイルの一覧（本体は返さない） */
  async function files() {
    if (!config.lndDir) return { dir: null, files: [] };
    const [methodPerms, lndIds] = await Promise.all([permissions(), lnd.listIds()]);
    const found = scanMacaroonFiles(config.lndDir);
    const ownFp = own().fingerprint;
    // 同じ macaroon が複数のファイルにあるかを見る
    const byFp = new Map();
    const result = [];
    for (const f of found) {
      const { bytes, ...meta } = f;
      if (!bytes) {
        result.push(meta);
        continue;
      }
      try {
        const info = M.inspect(bytes);
        const a = await analyze(bytes, info, methodPerms, lndIds);
        byFp.set(info.fingerprint, [...(byFp.get(info.fingerprint) || []), meta.path]);
        result.push({ ...meta, ...a, isOwn: a.fingerprint === ownFp });
      } catch (e) {
        result.push({ ...meta, error: `macaroon として読めません: ${e.message}` });
      }
    }
    for (const r of result) {
      if (r.fingerprint) r.sameAs = byFp.get(r.fingerprint).filter((p) => p !== r.path);
    }
    return { dir: config.lndDir, files: result };
  }

  async function deleteId(id) {
    id = parseRootKeyId(id);
    if (id === '0') throw new HttpError(400, 'ID 0 は LND の標準 ID で削除できません');
    if (id === own().id) throw new HttpError(400, 'このアプリ自身が使っている ID は削除できません');
    const lndIds = await lnd.listIds();
    if (lndIds.includes(id)) await lnd.deleteId(id);
    db.markDeleted(id);
    return { deleted: true };
  }

  // --- HTTP ---
  function cookie(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return v.join('=');
    }
    return null;
  }

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw new HttpError(413, '送信内容が大きすぎます');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'JSON が不正です');
    }
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  const sessionCookie = (token, maxAge) =>
    `mm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    try {
      if (req.method === 'GET' && STATIC[path]) {
        const [file, type] = STATIC[path];
        const full = resolve(publicDir, file);
        if (!existsSync(full)) throw new HttpError(404, 'not found');
        return send(res, 200, readFileSync(full), { 'Content-Type': type });
      }
      if (!path.startsWith('/api/')) throw new HttpError(404, 'not found');
      if (req.method !== 'GET' && !sameOrigin(req)) throw new HttpError(403, '別のサイトからの操作は受け付けません');

      if (path === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress || '';
        if (limiter.blocked(ip)) throw new HttpError(429, 'ログインの失敗が続いたため、しばらく待ってください');
        const body = await readJson(req);
        if (!config.passwordHash || !verifyPassword(body.password ?? '', config.passwordHash)) {
          limiter.fail(ip);
          throw new HttpError(401, 'パスワードが違います');
        }
        limiter.reset(ip);
        return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(sessions.create(), sessions.maxAgeSec) });
      }
      if (path === '/api/logout' && req.method === 'POST') {
        sessions.destroy(cookie(req, 'mm_session'));
        return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
      }

      if (!sessions.valid(cookie(req, 'mm_session'))) throw new HttpError(401, 'ログインしてください');

      if (path === '/api/state' && req.method === 'GET') {
        const [s, info] = await Promise.all([state(), lnd.getInfo().catch(() => null)]);
        return send(res, 200, { ...s, node: info && { alias: info.alias, pubkey: info.identity_pubkey, version: info.version } });
      }
      if (path === '/api/permissions' && req.method === 'GET') {
        return send(res, 200, { methods: await permissions() });
      }
      if (path === '/api/bake' && req.method === 'POST') {
        return send(res, 200, await bake(await readJson(req)));
      }
      if (path === '/api/files' && req.method === 'GET') {
        return send(res, 200, await files());
      }
      if (path === '/api/inspect' && req.method === 'POST') {
        return send(res, 200, await inspect(await readJson(req)));
      }
      const m = path.match(/^\/api\/ids\/([^/]+)$/);
      if (m && req.method === 'PATCH') {
        const id = parseRootKeyId(decodeURIComponent(m[1]));
        const body = await readJson(req);
        db.upsertKey(id, {
          name: body.name === undefined ? undefined : String(body.name).trim().slice(0, 100),
          memo: body.memo === undefined ? undefined : String(body.memo).trim().slice(0, 2000),
        });
        return send(res, 200, { ok: true });
      }
      if (m && req.method === 'DELETE') {
        return send(res, 200, await deleteId(decodeURIComponent(m[1])));
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
      if (status >= 500) console.error(e);
      return send(res, status, { error: e.message || 'エラー' });
    }
  };
}

export { HttpError };
