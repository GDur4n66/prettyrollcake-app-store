// .env を読んで設定を作る（Docker なしで npm start / systemd から起動する前提）
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadDotEnv(path = resolve(ROOT, '.env')) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function expand(p) {
  return p && p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p;
}

export function loadConfig(env = process.env) {
  const lndDir = expand(env.LND_DIR || '~/.lnd');
  const network = env.LND_NETWORK || 'mainnet';
  return {
    host: (env.HOST || '127.0.0.1').split(',').map((s) => s.trim()).filter(Boolean),
    port: Number(env.PORT || 3620),
    lndDir,
    lndRestUrl: (env.LND_REST_URL || 'https://127.0.0.1:8080').replace(/\/$/, ''),
    lndTlsCert: expand(env.LND_TLS_CERT || `${lndDir}/tls.cert`),
    lndMacaroon: expand(env.LND_MACAROON || `${lndDir}/data/chain/bitcoin/${network}/macaroon-manager.macaroon`),
    dbPath: expand(env.DB_PATH || resolve(ROOT, 'data/app.db')),
    passwordHash: env.ADMIN_PASSWORD_HASH || '',
    // 平文のパスワード（Umbrel の APP_PASSWORD など）。ハッシュが無いときだけ使う
    password: env.ADMIN_PASSWORD || '',
    lndTlsVerifyHostname: env.LND_TLS_VERIFY_HOSTNAME !== 'false',
    cookieSecure: env.COOKIE_SECURE === 'true',
    sessionHours: Number(env.SESSION_HOURS || 12),
  };
}
