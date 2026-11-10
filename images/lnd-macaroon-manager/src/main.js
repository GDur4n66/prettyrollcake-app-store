import { createServer } from 'node:http';
import { loadDotEnv, loadConfig } from './config.js';
import { createLnd } from './lnd.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { hashPassword } from './auth.js';

loadDotEnv();
const config = loadConfig();
if (!config.passwordHash && config.password) {
  if (config.password.length < 10) {
    console.error('ADMIN_PASSWORD は 10 文字以上にしてください');
    process.exit(1);
  }
  config.passwordHash = hashPassword(config.password);
  config.password = '';
  delete process.env.ADMIN_PASSWORD;
}
if (!config.passwordHash) {
  console.error('ADMIN_PASSWORD_HASH が未設定です。npm run hash-password で作って .env に書いてください');
  process.exit(1);
}

const lnd = createLnd(config);
const db = openDb(config.dbPath);
const handler = createApp({ config, lnd, db });

for (const host of config.host) {
  createServer(handler).listen(config.port, host, () => {
    console.log(`macaroon manager: http://${host.includes(':') ? `[${host}]` : host}:${config.port}/`);
  });
}

lnd
  .getInfo()
  .then((i) => console.log(`LND に接続: ${i.alias} (${i.version})`))
  .catch((e) => console.error(`LND に接続できません（画面を開いたときに再試行します）: ${e.message}`));

const stop = () => process.exit(0);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
