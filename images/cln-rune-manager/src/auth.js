// パスワード（scrypt）とセッション Cookie
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [kind, saltB64, hashB64] = String(stored).split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expect = Buffer.from(hashB64, 'base64');
  const got = scryptSync(String(password), Buffer.from(saltB64, 'base64'), expect.length, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(got, expect);
}

export function createSessions({ hours }) {
  const sessions = new Map();
  const ttl = hours * 3600 * 1000;
  return {
    create() {
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, Date.now() + ttl);
      return token;
    },
    valid(token) {
      if (!token) return false;
      const exp = sessions.get(token);
      if (!exp) return false;
      if (exp < Date.now()) {
        sessions.delete(token);
        return false;
      }
      return true;
    },
    destroy: (token) => sessions.delete(token),
    maxAgeSec: Math.floor(ttl / 1000),
  };
}

/** ログイン失敗の回数制限（IP ごと、15 分で 10 回まで） */
export function createLoginLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const fails = new Map();
  return {
    blocked(ip) {
      const e = fails.get(ip);
      if (!e) return false;
      if (e.until < Date.now()) {
        fails.delete(ip);
        return false;
      }
      return e.count >= max;
    },
    fail(ip) {
      const e = fails.get(ip);
      if (!e || e.until < Date.now()) fails.set(ip, { count: 1, until: Date.now() + windowMs });
      else e.count += 1;
    },
    reset: (ip) => fails.delete(ip),
  };
}
