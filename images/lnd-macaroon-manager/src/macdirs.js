// グループ（ルートキー ID）ごとのディレクトリ macaroon-id-<ID>/ に macaroon を置く・片付ける
//
// 置き場所（baseDir）は LND の data/chain/bitcoin/<network>/ で、wallet.db や macaroons.db と同じ場所。
// そのため、書く・消すのは baseDir 直下の macaroon-id-<数字>/ の中だけにし、
// シンボリックリンクはたどらず、消すのは中身を読んでその ID だと確かめた *.macaroon だけにする。
import {
  accessSync, constants, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync, chmodSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { inspect } from './macaroon.js';

const ID_RE = /^(0|[1-9][0-9]{0,19})$/;
// 名前の部分: 文字・数字・_ - .（先頭は . 以外）。フォルダの区切りや制御文字は入らない
const NAME_RE = /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,79}$/u;
const TMP_RE = /^\.mm-[0-9a-f]{16}\.tmp$/;
const MAX_SIZE = 64 * 1024;

export class MacDirError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const dirName = (id) => `macaroon-id-${id}`;

/** ファイル名を確かめて「名前.macaroon」にそろえる */
export function normalizeFileName(input) {
  let name = String(input ?? '').trim();
  if (name.endsWith('.macaroon')) name = name.slice(0, -'.macaroon'.length);
  if (!NAME_RE.test(name)) {
    throw new MacDirError('ファイル名は文字・数字・_ - . だけで、80 文字までにしてください（先頭に . は使えません）');
  }
  return `${name}.macaroon`;
}

export function createMacDirs({ baseDir }) {
  /** 置けるかどうか（Umbrel の読み取り専用など、書けない環境では使わない） */
  function status() {
    if (!baseDir) return { enabled: false, dir: null, reason: '置き場所が設定されていません' };
    try {
      const st = lstatSync(baseDir);
      if (!st.isDirectory()) return { enabled: false, dir: baseDir, reason: `${baseDir} はディレクトリではありません` };
      accessSync(baseDir, constants.W_OK);
      return { enabled: true, dir: baseDir, reason: '' };
    } catch (e) {
      const reason = e.code === 'ENOENT' ? `${baseDir} がありません`
        : e.code === 'EACCES' || e.code === 'EROFS' || e.code === 'EPERM' ? `${baseDir} に書き込めません（読み取り専用）`
          : `${baseDir} を使えません: ${e.message}`;
      return { enabled: false, dir: baseDir, reason };
    }
  }

  /** baseDir 直下の macaroon-id-<id> のパス。リンクや外側を指していないかも確かめる */
  function groupDir(id, { create = false } = {}) {
    id = String(id);
    if (!ID_RE.test(id)) throw new MacDirError('ID が不正です');
    const s = status();
    if (!s.enabled) throw new MacDirError(s.reason, 409);
    const dir = join(baseDir, dirName(id));
    let st;
    try {
      st = lstatSync(dir);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (!create) return null;
      mkdirSync(dir, { mode: 0o700 });
      st = lstatSync(dir);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new MacDirError(`${dir} がディレクトリではない（シンボリックリンクなど）ため、触りません`, 409);
    }
    if (dirname(realpathSync(dir)) !== realpathSync(baseDir)) {
      throw new MacDirError(`${dir} が置き場所の外を指しているため、触りません`, 409);
    }
    return dir;
  }

  /**
   * macaroon をグループのディレクトリに置く（600）。
   * 同じ名前があれば overwrite のときだけ置き換える（一時ファイルに書いてから入れ替える）
   */
  function save({ rootKeyId, fileName, bytes, overwrite = false }) {
    const name = normalizeFileName(fileName);
    if (String(rootKeyId) === '0') throw new MacDirError('ID 0（LND 標準）には置きません');
    const info = inspect(bytes);
    if (info.rootKeyId !== String(rootKeyId)) throw new MacDirError('macaroon の ID とグループが一致しません');
    const dir = groupDir(rootKeyId, { create: true });
    const target = join(dir, name);
    let existed = false;
    try {
      const st = lstatSync(target);
      if (!st.isFile()) throw new MacDirError(`${target} はファイルではないため、置き換えません`, 409);
      if (!overwrite) throw new MacDirError(`${name} はもうあります`, 409);
      existed = true;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const tmp = join(dir, `.mm-${randomBytes(8).toString('hex')}.tmp`);
    writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
    try {
      chmodSync(tmp, 0o600); // umask に関係なく 600
      renameSync(tmp, target);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* 消せなくても次の片付けで消える */ }
      throw e;
    }
    return { path: target, dir, name, replaced: existed };
  }

  /**
   * グループを削除したあとの片付け。
   * その ID の *.macaroon と、このアプリの一時ファイルだけを消し、空になったらディレクトリも消す。
   * それ以外（手で置いたファイル・別の ID の macaroon・読めないもの）は残して返す
   */
  function removeGroup(rootKeyId) {
    const result = { dir: null, removed: [], kept: [], dirRemoved: false };
    if (!status().enabled) return result;
    const dir = groupDir(rootKeyId);
    if (!dir) return result;
    result.dir = dir;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isFile() && TMP_RE.test(e.name)) {
        unlinkSync(full);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.macaroon')) {
        result.kept.push({ name: e.name, reason: 'macaroon ではありません' });
        continue;
      }
      try {
        if (lstatSync(full).size > MAX_SIZE) throw new Error('大きすぎます');
        const id = inspect(readFileSync(full)).rootKeyId;
        if (id !== String(rootKeyId)) {
          result.kept.push({ name: e.name, reason: `別の ID（${id}）の macaroon です` });
          continue;
        }
      } catch (err) {
        result.kept.push({ name: e.name, reason: `macaroon として読めません: ${err.message}` });
        continue;
      }
      unlinkSync(full);
      result.removed.push(e.name);
    }
    if (readdirSync(dir).length === 0) {
      rmdirSync(dir);
      result.dirRemoved = true;
    }
    return result;
  }

  return { status, save, removeGroup, dirFor: (id) => (baseDir ? join(baseDir, dirName(id)) : null) };
}
