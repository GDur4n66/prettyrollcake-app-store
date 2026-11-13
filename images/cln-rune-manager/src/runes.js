// 画面の入力から createrune の restrictions（制限の配列）を作る
//   外側の配列は AND、内側の配列は OR（alternatives）

export class RuneInputError extends Error {}

const OPS = '=/^$~<>{}#!';
const ALT_RE = /^([^=/^$~<>{}#!]*)([=/^$~<>{}#!])(.*)$/s;
const FIELD_RE = /^[A-Za-z0-9_]+$/;
const METHOD_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PER_RE = /^[1-9][0-9]{0,8}(nsec|usec|msec|sec|min|hour|day)$/;

/** 読み取り専用（CLN の "readonly" と同じ中身） */
export const READONLY_METHOD_ALTS = ['method^list', 'method^get', 'method=summary'];
export const READONLY_EXTRA = ['method/listdatastore'];

/** 1つの条件（alternative）を確かめて、そのまま返す */
export function checkAlternative(s) {
  const text = String(s ?? '').trim();
  const m = text.match(ALT_RE);
  if (!m) throw new RuneInputError(`条件の形が不正です: ${text || '(空)'}（例: method=invoice）。使える記号は ${OPS}`);
  const [, field, op, value] = m;
  if (op !== '#' && !FIELD_RE.test(field)) throw new RuneInputError(`条件の名前が不正です: ${text}`);
  if (op === '!' && value !== '') throw new RuneInputError(`「!」の後ろには何も書けません: ${text}`);
  if ((op === '<' || op === '>') && !/^-?[0-9]+$/.test(value)) throw new RuneInputError(`「${op}」の後ろは整数にしてください: ${text}`);
  return text;
}

/** 詳細設定の行（1行が1つの制限。「|」で区切ると「どれか1つ」。「\|」は文字の |） */
export function parseExtraLines(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const alts = line
      .split(/(?<!\\)\|/)
      .map((a) => a.replace(/\\\|/g, '|').trim())
      .filter(Boolean)
      .map(checkAlternative);
    if (alts.length) out.push(alts);
  }
  return out;
}

/**
 * input:
 *  - allowAll: true ならコマンドを絞らない
 *  - readonly: 読み取り系（list*・get*・summary）を許可
 *  - methods: 許可するコマンド名の配列
 *  - expiresAt: 期限（ISO 文字列）
 *  - rate: 1 分あたりの回数 / per: 「1 回あたりの間隔」（5sec, 1hour, 1day など）
 *  - extra: 詳細設定の行（文字列）
 */
export function buildRestrictions(input, { now = Date.now() } = {}) {
  const restrictions = [];
  const methods = [...new Set((input.methods ?? []).map((m) => String(m).trim()).filter(Boolean))].sort();
  for (const m of methods) if (!METHOD_RE.test(m)) throw new RuneInputError(`コマンド名が不正です: ${m}`);

  if (input.allowAll) {
    if (methods.length || input.readonly) throw new RuneInputError('「コマンドを絞らない」と、コマンドの選択は同時に使えません');
  } else {
    if (!methods.length && !input.readonly) throw new RuneInputError('許可するコマンドを1つ以上選んでください');
    if (input.readonly && methods.includes('listdatastore')) {
      throw new RuneInputError('読み取り専用では listdatastore を除くため、listdatastore は選べません');
    }
    restrictions.push([...(input.readonly ? READONLY_METHOD_ALTS : []), ...methods.map((m) => `method=${m}`)]);
    if (input.readonly) restrictions.push([...READONLY_EXTRA]);
  }

  if (input.expiresAt) {
    const t = new Date(input.expiresAt).getTime();
    if (Number.isNaN(t)) throw new RuneInputError('有効期限の日時が不正です');
    if (t <= now) throw new RuneInputError('有効期限が過去になっています');
    restrictions.push([`time<${Math.floor(t / 1000)}`]);
  }

  if (input.rate !== undefined && input.rate !== null && input.rate !== '') {
    const n = Number(input.rate);
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new RuneInputError('1 分あたりの回数は 1 以上の整数にしてください');
    restrictions.push([`rate=${n}`]);
  }
  if (input.per) {
    const p = String(input.per).trim();
    if (!PER_RE.test(p)) throw new RuneInputError(`間隔の指定が不正です: ${p}（例: 5sec, 1hour, 1day）`);
    restrictions.push([`per=${p}`]);
  }

  restrictions.push(...parseExtraLines(input.extra));
  if (input.allowAll && !restrictions.length) return []; // 制限なし（全権限）
  return restrictions;
}
