// LND のフォルダにある *.macaroon ファイルを探す
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';

const MAX_DEPTH = 8;
const MAX_FILES = 200;
const MAX_SIZE = 64 * 1024;

// LND が自分で作るファイル（lnd.conf の no-macaroons 等で変わる）
export const STANDARD = {
  'admin.macaroon': 'LND 標準：すべての権限',
  'readonly.macaroon': 'LND 標準：読み取りのみ',
  'invoice.macaroon': 'LND 標準：請求書の発行',
  'invoices.macaroon': 'LND 標準：invoicesrpc（ホールド請求書など）',
  'router.macaroon': 'LND 標準：routerrpc（支払いの経路・送金）',
  'signer.macaroon': 'LND 標準：signrpc（鍵で署名）',
  'walletkit.macaroon': 'LND 標準：walletrpc（オンチェーンのウォレット操作）',
  'chainnotifier.macaroon': 'LND 標準：chainrpc（ブロック・取引の通知）',
};

export function scanMacaroonFiles(lndDir) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.macaroon')) {
        const st = lstatSync(full);
        const item = {
          name: e.name,
          path: relative(lndDir, full),
          size: st.size,
          mode: (st.mode & 0o777).toString(8).padStart(3, '0'),
          uid: st.uid,
          mtime: st.mtime.toISOString(),
          otherReadable: (st.mode & 0o004) !== 0,
          groupReadable: (st.mode & 0o040) !== 0,
          standard: STANDARD[e.name] ?? null,
        };
        try {
          if (st.size > MAX_SIZE) throw new Error('ファイルが大きすぎます');
          item.bytes = readFileSync(full);
        } catch (err) {
          item.error = `読めません: ${err.code === 'EACCES' ? '権限がありません' : err.message}`;
        }
        out.push(item);
      }
      // シンボリックリンクはたどらない
    }
  };
  walk(lndDir, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
