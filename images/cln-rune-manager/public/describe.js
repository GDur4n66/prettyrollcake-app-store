// rune の条件を日本語にする（画面とテストで共用）

const OP_JA = {
  '=': 'が「$v」',
  '/': 'が「$v」以外',
  '^': 'が「$v」で始まる',
  $: 'が「$v」で終わる',
  '~': 'に「$v」を含む',
  '<': 'が $v より小さい',
  '>': 'が $v より大きい',
  '{': 'が「$v」より前（辞書順）',
  '}': 'が「$v」より後（辞書順）',
  '!': 'がない',
};

const PER_UNIT = { nsec: 'ナノ秒', usec: 'マイクロ秒', msec: 'ミリ秒', sec: '秒', min: '分', hour: '時間', day: '日' };

export function perJa(v) {
  const m = String(v).match(/^(\d+)([a-z]*)$/);
  if (!m) return v;
  return `${m[1]} ${PER_UNIT[m[2] || 'sec'] ?? m[2]}`;
}

function fmtTime(sec) {
  const d = new Date(Number(sec) * 1000);
  if (Number.isNaN(d.getTime())) return sec;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fieldJa(f) {
  if (f === 'method') return 'コマンド';
  if (f === 'id') return '接続元ノード';
  if (f === 'pnum') return '引数の数';
  let m = f.match(/^pinv(.+)_(amount|description|node)$/);
  if (m) return `引数 ${m[1]} の請求書の${{ amount: '金額', description: '説明', node: '宛先ノード' }[m[2]]}`;
  m = f.match(/^pname(.+)$/);
  if (m) return `引数 ${m[1]}`;
  m = f.match(/^parr(\d+)$/);
  if (m) return `${Number(m[1]) + 1} 番目の引数`;
  return f;
}

/** 文字列（"method=pay"）を { fieldname, condition, value } にする */
export function splitAlt(s) {
  const m = String(s).match(/^([^=/^$~<>{}#!]*)([=/^$~<>{}#!])(.*)$/s);
  return m ? { fieldname: m[1], condition: m[2], value: m[3] } : { fieldname: s, condition: '', value: '' };
}

export function altJa(a) {
  const { fieldname: f, condition: c, value: v } = typeof a === 'string' ? splitAlt(a) : a;
  if (c === '#') return `メモ: ${f}${v}`;
  if (f === 'rate' && c === '=') return `1 分に ${v} 回まで`;
  if (f === 'per' && c === '=') return `${perJa(v)}に 1 回まで`;
  if (f === 'time' && c === '<') return `${fmtTime(v)} まで有効`;
  if (f === 'time' && c === '>') return `${fmtTime(v)} から有効`;
  if (f === 'method' && c === '=') return `コマンド ${v}`;
  if (f === 'method' && c === '^') return `${v}… で始まるコマンド`;
  if (f === 'method' && c === '/') return `${v} 以外のコマンド`;
  const tpl = OP_JA[c];
  const name = fieldJa(f);
  // 英数字で終わる名前（引数名など）の後ろは空ける
  return tpl ? `${name}${/[A-Za-z0-9_]$/.test(name) ? ' ' : ''}${tpl.replace('$v', v)}` : `${f}${c}${v}`;
}

/** 1つの制限（alternatives の配列）を1行に */
export function restrictionJa(alts) {
  const list = alts.map(altJa);
  // コマンドだけの並びは「コマンド: a, b, c」にまとめる
  const parsed = alts.map((a) => (typeof a === 'string' ? splitAlt(a) : a));
  if (parsed.length > 1 && parsed.every((p) => p.fieldname === 'method' && (p.condition === '=' || p.condition === '^'))) {
    return `使えるコマンド: ${parsed.map((p) => (p.condition === '^' ? `${p.value}…` : p.value)).join(', ')}`;
  }
  return list.join(' または ');
}

/** 時間が過ぎたかどうか（time< の制限があって過去なら true） */
export function expiredAt(restrictions, now = Date.now()) {
  for (const r of restrictions) {
    if (r.length !== 1) continue;
    const p = typeof r[0] === 'string' ? splitAlt(r[0]) : r[0];
    if (p.fieldname === 'time' && p.condition === '<' && Number(p.value) * 1000 <= now) return true;
  }
  return false;
}

/** お金が動く・権限が広がるなど、注意が要るコマンド */
export const DANGEROUS = new Set([
  'pay', 'xpay', 'keysend', 'sendpay', 'sendonion', 'renepay', 'withdraw', 'txsend', 'fundchannel', 'multifundchannel',
  'close', 'createrune', 'blacklistrune', 'commando-rune', 'datastore', 'deldatastore', 'listdatastore', 'setconfig',
  'plugin', 'stop', 'sendcustommsg', 'fundpsbt', 'signpsbt', 'sendpsbt', 'fetchinvoice', 'sendinvoice', 'recover',
  'makesecret', 'exposesecret', 'injectpaymentonion', 'emergencyrecover', 'upgradewallet', 'sql',
]);
export const isDangerous = (m) => DANGEROUS.has(m) || m.startsWith('dev-');
