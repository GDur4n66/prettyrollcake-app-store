// macaroon（v2 バイナリ形式）の読み書きと、LND が使う識別子・caveat の解釈。
import { createHmac } from 'node:crypto';

const F_EOS = 0;
const F_LOCATION = 1;
const F_IDENTIFIER = 2;
const F_VID = 4;
const F_SIGNATURE = 6;

function readUvarint(buf, pos) {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('macaroon が途中で切れています');
    const b = buf[pos++];
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [value, pos];
    shift += 7;
    if (shift > 49) throw new Error('macaroon の長さ情報が不正です');
  }
}

function writeUvarint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return Buffer.from(out);
}

function readField(buf, pos) {
  if (pos >= buf.length) throw new Error('macaroon が途中で切れています');
  const type = buf[pos++];
  if (type === F_EOS) return [{ type }, pos];
  let len;
  [len, pos] = readUvarint(buf, pos);
  if (pos + len > buf.length) throw new Error('macaroon が途中で切れています');
  return [{ type, data: buf.subarray(pos, pos + len) }, pos + len];
}

function field(type, data) {
  return Buffer.concat([Buffer.from([type]), writeUvarint(data.length), data]);
}

/** 文字列（hex / base64 / base64url）またはバイト列を macaroon のバイト列にする */
export function toBytes(input) {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) return Buffer.from(input);
  const s = String(input).replace(/\s+/g, '');
  if (!s) throw new Error('macaroon が空です');
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  throw new Error('hex または base64 の macaroon を入力してください');
}

/** v2 バイナリを { location, identifier, caveats, signature } に分解する */
export function parse(input) {
  const buf = toBytes(input);
  if (buf.length < 2 || buf[0] !== 2) {
    throw new Error('macaroon（v2 形式）として読めません');
  }
  let pos = 1;
  let f;
  const mac = { location: '', identifier: null, caveats: [], signature: null };

  for (;;) {
    [f, pos] = readField(buf, pos);
    if (f.type === F_EOS) break;
    if (f.type === F_LOCATION) mac.location = f.data.toString('utf8');
    else if (f.type === F_IDENTIFIER) mac.identifier = Buffer.from(f.data);
    else throw new Error('macaroon の先頭部分が不正です');
  }
  if (!mac.identifier) throw new Error('macaroon に識別子がありません');

  for (;;) {
    [f, pos] = readField(buf, pos);
    if (f.type === F_EOS) break;
    const cav = { location: '', id: null, vid: null };
    while (f.type !== F_EOS) {
      if (f.type === F_LOCATION) cav.location = f.data.toString('utf8');
      else if (f.type === F_IDENTIFIER) cav.id = Buffer.from(f.data);
      else if (f.type === F_VID) cav.vid = Buffer.from(f.data);
      else throw new Error('macaroon の caveat が不正です');
      [f, pos] = readField(buf, pos);
    }
    if (!cav.id) throw new Error('macaroon の caveat に識別子がありません');
    mac.caveats.push(cav);
  }

  [f, pos] = readField(buf, pos);
  if (f.type !== F_SIGNATURE || f.data.length !== 32) throw new Error('macaroon の署名が不正です');
  mac.signature = Buffer.from(f.data);
  return mac;
}

export function serialize(mac) {
  const parts = [Buffer.from([2])];
  if (mac.location) parts.push(field(F_LOCATION, Buffer.from(mac.location, 'utf8')));
  parts.push(field(F_IDENTIFIER, mac.identifier), Buffer.from([F_EOS]));
  for (const c of mac.caveats) {
    if (c.location) parts.push(field(F_LOCATION, Buffer.from(c.location, 'utf8')));
    parts.push(field(F_IDENTIFIER, c.id));
    if (c.vid) parts.push(field(F_VID, c.vid));
    parts.push(Buffer.from([F_EOS]));
  }
  parts.push(Buffer.from([F_EOS]), field(F_SIGNATURE, mac.signature));
  return Buffer.concat(parts);
}

/** first-party caveat を足す（署名は HMAC-SHA256(旧署名, 条件) で更新される） */
export function addFirstPartyCaveat(mac, condition) {
  const id = Buffer.from(condition, 'utf8');
  return {
    ...mac,
    caveats: [...mac.caveats, { location: '', id, vid: null }],
    signature: createHmac('sha256', mac.signature).update(id).digest(),
  };
}

// --- protobuf（LND の MacaroonId）の最小限の読み取り ---
function readProto(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readUvarint(buf, pos);
    const num = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 2) {
      let len;
      [len, pos] = readUvarint(buf, pos);
      if (pos + len > buf.length) throw new Error('識別子が途中で切れています');
      fields.push({ num, data: buf.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 0) {
      let v;
      [v, pos] = readUvarint(buf, pos);
      fields.push({ num, value: v });
    } else {
      throw new Error('識別子の形式が想定外です');
    }
  }
  return fields;
}

/** LND の識別子（先頭 0x03 + MacaroonId）から ルートキー ID と権限を取り出す */
export function decodeIdentifier(identifier) {
  if (identifier[0] !== 3) throw new Error('LND の macaroon ではないようです（識別子の版が違います）');
  const out = { nonce: '', rootKeyId: '', ops: [] };
  for (const f of readProto(identifier.subarray(1))) {
    if (f.num === 1 && f.data) out.nonce = Buffer.from(f.data).toString('hex');
    else if (f.num === 2 && f.data) out.rootKeyId = Buffer.from(f.data).toString('utf8');
    else if (f.num === 3 && f.data) {
      const op = { entity: '', actions: [] };
      for (const g of readProto(f.data)) {
        if (g.num === 1 && g.data) op.entity = Buffer.from(g.data).toString('utf8');
        else if (g.num === 2 && g.data) op.actions.push(Buffer.from(g.data).toString('utf8'));
      }
      out.ops.push(op);
    }
  }
  return out;
}

/** caveat の条件を人が読める形に分類する */
export function describeCaveat(condition, now = new Date()) {
  const sp = condition.indexOf(' ');
  const name = sp < 0 ? condition : condition.slice(0, sp);
  const arg = sp < 0 ? '' : condition.slice(sp + 1);
  switch (name) {
    case 'time-before': {
      const t = new Date(arg);
      const valid = !Number.isNaN(t.getTime());
      return { kind: 'expiry', condition, expiresAt: valid ? t.toISOString() : null, expired: valid ? t <= now : null };
    }
    case 'ipaddr':
      return { kind: 'ip', condition, ip: arg };
    case 'iprange':
      return { kind: 'iprange', condition, range: arg };
    case 'lnd-custom':
      return { kind: 'custom', condition };
    default:
      return { kind: 'other', condition };
  }
}

/** macaroon をまとめて読む。署名の指紋は同じ ID の中で個体を見分けるのに使う */
export function inspect(input, now = new Date()) {
  const mac = parse(input);
  const id = decodeIdentifier(mac.identifier);
  const caveats = mac.caveats.map((c) =>
    c.vid ? { kind: 'third-party', condition: c.id.toString('utf8'), location: c.location } : describeCaveat(c.id.toString('utf8'), now),
  );
  return {
    rootKeyId: id.rootKeyId,
    nonce: id.nonce,
    ops: id.ops,
    caveats,
    location: mac.location,
    fingerprint: mac.signature.toString('hex').slice(0, 16),
  };
}

export function fingerprintOf(input) {
  return parse(input).signature.toString('hex').slice(0, 16);
}

/** 有効期限・IP 制限を付けた macaroon を返す（lncli bakemacaroon --timeout / --ip_address と同じ条件文） */
export function constrain(input, { expiresAt, ipAddress, ipRange } = {}) {
  let mac = parse(input);
  if (expiresAt) {
    const t = new Date(expiresAt);
    if (Number.isNaN(t.getTime())) throw new Error('有効期限の日時が不正です');
    mac = addFirstPartyCaveat(mac, `time-before ${t.toISOString().replace('.000Z', 'Z')}`);
  }
  if (ipAddress) mac = addFirstPartyCaveat(mac, `ipaddr ${normalizeIp(ipAddress)}`);
  if (ipRange) mac = addFirstPartyCaveat(mac, `iprange ${normalizeCidr(ipRange)}`);
  return serialize(mac);
}

function normalizeIp(ip) {
  const s = String(ip).trim();
  if (/^(\d{1,3})(\.\d{1,3}){3}$/.test(s) && s.split('.').every((x) => Number(x) <= 255)) {
    return s.split('.').map(Number).join('.');
  }
  if (/^[0-9a-fA-F:]+$/.test(s) && s.includes(':')) return s.toLowerCase();
  throw new Error('IP アドレスが不正です');
}

function normalizeCidr(cidr) {
  const m = String(cidr).trim().match(/^([0-9.]+)\/(\d{1,2})$/);
  if (!m) throw new Error('IP の範囲は 192.0.2.0/24 のように入力してください（IPv4 のみ）');
  const bits = Number(m[2]);
  if (bits > 32) throw new Error('IP の範囲が不正です');
  const parts = normalizeIp(m[1]).split('.').map(Number);
  const n = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = (n & mask) >>> 0;
  return `${[24, 16, 8, 0].map((s) => (net >>> s) & 255).join('.')}/${bits}`;
}

/** 権限一覧（ListPermissions の method_permissions）から、この macaroon で呼べる RPC を出す */
export function allowedMethods(ops, methodPermissions) {
  const granted = new Set();
  const uris = new Set();
  for (const op of ops) {
    for (const a of op.actions) {
      if (op.entity === 'uri') uris.add(a);
      else granted.add(`${op.entity}:${a}`);
    }
  }
  const allowed = [];
  for (const [method, v] of Object.entries(methodPermissions)) {
    const perms = v.permissions || [];
    const byPerm = perms.length > 0 && perms.every((p) => granted.has(`${p.entity}:${p.action}`));
    if (byPerm || uris.has(method)) allowed.push(method);
  }
  return allowed.sort();
}
