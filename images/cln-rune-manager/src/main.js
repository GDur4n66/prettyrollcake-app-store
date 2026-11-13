import { createServer } from 'node:http';
import { loadDotEnv, loadConfig } from './config.js';
import { createCln } from './cln.js';
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
if (!config.clnRpcSocket && !config.clnRune) {
  console.error('CLN_RPC_SOCKET（CLN のソケット）か CLN_RUNE（制限のない rune、lightning-cli createrune で作る）を .env に書いてください');
  process.exit(1);
}

const cln = createCln(config);
const db = openDb(config.dbPath);
const handler = createApp({ config, cln, db });

for (const host of config.host) {
  createServer(handler).listen(config.port, host, () => {
    console.log(`rune manager: http://${host.includes(':') ? `[${host}]` : host}:${config.port}/`);
  });
}

cln
  .getInfo()
  .then((i) => {
    console.log(`CLN に接続: ${i.alias} (${i.version})${cln.tlsMode === 'socket' ? ` ソケット ${config.clnRpcSocket}` : ''}`);
    if (cln.tlsMode === 'none' && cln.lastFingerprint()) {
      console.log(`clnrest の証明書を確かめていません。固定するには .env に CLN_TLS_FINGERPRINT=${cln.lastFingerprint()}`);
    }
  })
  .catch((e) => console.error(`CLN に接続できません（画面を開いたときに再試行します）: ${e.message}`));

const stop = () => process.exit(0);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
