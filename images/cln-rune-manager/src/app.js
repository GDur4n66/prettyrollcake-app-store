// HTTP のルーティングと各操作
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.js';
import { verifyPassword, createSessions, createLoginLimiter } from './auth.js';
import { buildRestrictions, RuneInputError } from './runes.js';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/describe.js': ['describe.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ID_RE = /^(0|[1-9][0-9]{0,19})$/;
function parseId(v) {
  const s = String(v ?? '').trim();
  if (!ID_RE.test(s)) throw new HttpError(400, 'ID は 0 以上の整数です');
  return s;
}
const byIdDesc = (a, b) => (BigInt(b.uniqueId) > BigInt(a.uniqueId) ? 1 : BigInt(b.uniqueId) < BigInt(a.uniqueId) ? -1 : 0);

/** "v25.02.1" → [25, 2]。読めなければ null */
export function parseVersion(v) {
  const m = String(v ?? '').match(/v?(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const toView = (r) => ({
  uniqueId: String(r.unique_id),
  restrictions: (r.restrictions ?? []).map((x) => ({
    english: x.english,
    alternatives: (x.alternatives ?? []).map((a) => ({ fieldname: a.fieldname, condition: a.condition, value: a.value, english: a.english })),
  })),
  english: r.restrictions_as_english ?? '',
  blacklisted: r.blacklisted === true,
  lastUsed: typeof r.last_used === 'number' ? new Date(r.last_used * 1000).toISOString() : null,
});

export function createApp({ config, cln, db, publicDir = resolve(ROOT, 'public') }) {
  const sessions = createSessions({ hours: config.sessionHours });
  const limiter = createLoginLimiter();

  // このアプリ自身の rune の ID（無効化して締め出されないように）
  let ownId = null;
  async function getOwnId() {
    if (ownId === null) {
      const own = cln.ownRune();
      const [r] = own ? await cln.showRunes(own) : [];
      ownId = r ? String(r.unique_id) : '';
    }
    return ownId || null;
  }

  async function state() {
    const [list, own, info] = await Promise.all([cln.showRunes(), getOwnId(), cln.getInfo().catch(() => null)]);
    const recs = new Map(db.all().map((r) => [r.unique_id, r]));
    const ver = parseVersion(info?.version);
    return {
      node: info && { alias: info.alias, id: info.id, version: info.version, network: info.network },
      relistSupported: ver ? ver[0] > 25 || (ver[0] === 25 && ver[1] >= 2) : null,
      tls: { mode: cln.tlsMode, fingerprint: cln.lastFingerprint() },
      restUrl: config.clnPublicRestUrl || (config.clnRpcSocket ? null : config.clnRestUrl),
      ownId: own,
      runes: list
        .map((r) => {
          const v = toView(r);
          const rec = recs.get(v.uniqueId);
          return { ...v, name: rec?.name ?? '', memo: rec?.memo ?? '', createdHere: rec?.created_here === 1, isOwn: v.uniqueId === own };
        })
        .sort(byIdDesc),
    };
  }

  async function create(body) {
    const name = String(body.name ?? '').trim().slice(0, 100);
    const memo = String(body.memo ?? '').trim().slice(0, 2000);
    if (!name) throw new HttpError(400, '名前を入れてください（何に使う rune か）');
    let restrictions;
    try {
      restrictions = buildRestrictions(body);
    } catch (e) {
      if (e instanceof RuneInputError) throw new HttpError(400, e.message);
      throw e;
    }
    if (!restrictions.length && body.confirmUnrestricted !== true) {
      throw new HttpError(400, '制限のない rune（全権限）を作るには確認が必要です');
    }
    const r = await cln.createRune(restrictions);
    const uniqueId = String(r.unique_id);
    db.upsert(uniqueId, { name, memo, createdHere: true });
    return { uniqueId, rune: r.rune, restrictions, unrestricted: !!r.warning_unrestricted_rune };
  }

  async function findStored(id) {
    const r = (await cln.showRunes()).find((x) => String(x.unique_id) === id);
    if (!r) throw new HttpError(404, `ID ${id} の rune は CLN に保存されていません`);
    return r;
  }

  async function setBlacklist(id, relist) {
    id = parseId(id);
    if (!relist && id === (await getOwnId())) throw new HttpError(400, 'このアプリ自身が使っている rune は無効化できません');
    await findStored(id);
    try {
      await cln.blacklist({ start: id, relist });
    } catch (e) {
      if (relist && /relist|unknown|invalid/i.test(e.message)) {
        throw new HttpError(400, `取り消しに失敗しました（CLN 25.02 以降が必要です）: ${e.message}`);
      }
      throw e;
    }
    return { ok: true };
  }

  async function inspect(body) {
    const rune = String(body.rune ?? '').trim();
    if (!rune) throw new HttpError(400, 'rune を入れてください');
    if (!/^[A-Za-z0-9_=-]+$/.test(rune) || rune.length > 4096) throw new HttpError(400, 'rune の形ではありません');
    let decoded;
    try {
      [decoded] = await cln.showRunes(rune);
    } catch (e) {
      throw new HttpError(400, `rune を読めません: ${e.message}`);
    }
    if (!decoded) throw new HttpError(400, 'rune を読めません');
    const v = toView(decoded);
    const ours = decoded.our_rune !== false;
    // 保存済みの一覧に載っていれば無効化の状態はそちらが正しい
    const stored = ours ? (await cln.showRunes()).find((x) => String(x.unique_id) === v.uniqueId) : null;
    if (stored) v.blacklisted = stored.blacklisted === true;
    const rec = ours ? db.get(v.uniqueId) : null;
    let check = null;
    const method = String(body.method ?? '').trim();
    if (method) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(method)) throw new HttpError(400, 'コマンド名が不正です');
      let params = {};
      if (body.params !== undefined && String(body.params).trim()) {
        try {
          params = JSON.parse(String(body.params));
        } catch {
          throw new HttpError(400, '引数は JSON で書いてください（例: {"amount_msat": 1000}）');
        }
        if (params === null || typeof params !== 'object') throw new HttpError(400, '引数は JSON のオブジェクトか配列にしてください');
      }
      check = { method, ...(await cln.checkRune({ rune, method, params })) };
    }
    return {
      ...v,
      ours,
      stored: !!stored,
      isOwn: ours && v.uniqueId === (await getOwnId()),
      record: rec && { name: rec.name, memo: rec.memo },
      check,
    };
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
    `rm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;

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
        sessions.destroy(cookie(req, 'rm_session'));
        return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
      }

      if (!sessions.valid(cookie(req, 'rm_session'))) throw new HttpError(401, 'ログインしてください');

      if (path === '/api/state' && req.method === 'GET') return send(res, 200, await state());
      if (path === '/api/commands' && req.method === 'GET') return send(res, 200, { commands: await cln.listCommands() });
      if (path === '/api/runes' && req.method === 'POST') return send(res, 200, await create(await readJson(req)));
      if (path === '/api/inspect' && req.method === 'POST') return send(res, 200, await inspect(await readJson(req)));

      const m = path.match(/^\/api\/runes\/([^/]+)(?:\/(rune|blacklist|relist))?$/);
      if (m) {
        const id = parseId(decodeURIComponent(m[1]));
        if (!m[2] && req.method === 'PATCH') {
          const body = await readJson(req);
          db.upsert(id, {
            name: body.name === undefined ? undefined : String(body.name).trim().slice(0, 100),
            memo: body.memo === undefined ? undefined : String(body.memo).trim().slice(0, 2000),
          });
          return send(res, 200, { ok: true });
        }
        if (m[2] === 'rune' && req.method === 'GET') return send(res, 200, { rune: (await findStored(id)).rune });
        if (m[2] === 'blacklist' && req.method === 'POST') return send(res, 200, await setBlacklist(id, false));
        if (m[2] === 'relist' && req.method === 'POST') return send(res, 200, await setBlacklist(id, true));
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
