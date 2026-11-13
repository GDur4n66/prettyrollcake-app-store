// CLN の clnrest（rune まわりだけ）
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { isIP, createConnection } from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export class ClnError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code; // CLN のエラーコード（1501 など）
  }
}

/** 権限エラーのときに、このプロセスから見えるソケットまわりの状態を説明する */
export function describeSocketAccess(socketPath) {
  const st = (p) => {
    try {
      const s = statSync(p);
      return `${s.uid}:${s.gid} ${(s.mode & 0o7777).toString(8).padStart(4, '0')}`;
    } catch (e) {
      return e.code === 'EACCES' ? '見られない（フォルダに入れない）' : e.code === 'ENOENT' ? 'ない' : e.code || e.message;
    }
  };
  let caps = '';
  try {
    const eff = readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\s*([0-9a-f]+)/m)?.[1];
    if (eff) caps = BigInt(`0x${eff}`) === 0n ? '特権なし' : (BigInt(`0x${eff}`) >> 1n) & 1n ? '特権あり（DAC_OVERRIDE を含む）' : `特権あり（${eff}）`;
  } catch {
    /* /proc がない */
  }
  const uid = process.getuid?.() ?? '?';
  const gid = process.getgid?.() ?? '?';
  return `フォルダ ${dirname(socketPath)}: ${st(dirname(socketPath))}、ソケット: ${st(socketPath)}、このアプリ: ${uid}:${gid}${caps ? ` ${caps}` : ''}`;
}

const normFp = (s) => String(s || '').replace(/[^0-9a-f]/gi, '').toUpperCase();

/**
 * TLS の確かめ方
 * - caCert: その CA で署名されていれば OK（ホスト名は見ない。clnrest の証明書は IP 用に作られていないため）
 * - fingerprint: サーバー証明書の SHA-256 が一致すれば OK
 * - どちらもなし: 確かめない（LAN 内の自己署名向け。画面に警告を出す）
 *
 * clnRpcSocket を指定すると、clnrest ではなく lightning-rpc（Unix ソケット）で話す。
 * そのときは rune も TLS も使わない（tlsMode は 'socket'）
 */
export function createCln({ clnRestUrl, clnRune, clnCaCert = null, clnTlsFingerprint = null, clnRpcSocket = null }) {
  const useSocket = !!clnRpcSocket;
  const base = useSocket ? null : new URL(clnRestUrl);
  const tlsMode = useSocket ? 'socket' : clnCaCert ? 'ca' : clnTlsFingerprint ? 'fingerprint' : 'none';
  const isHttps = !useSocket && base.protocol === 'https:';
  let lastFingerprint = null;

  /** TLS をつないで証明書を確かめる（rune を送る前に） */
  function connectTls(ca) {
    return new Promise((resolvePromise, reject) => {
      const host = base.hostname.replace(/^\[|\]$/g, '');
      const sock = tlsConnect({
        host,
        port: Number(base.port || 443),
        ...(isIP(host) ? {} : { servername: host }),
        ALPNProtocols: ['http/1.1'], // clnrest は HTTP/2 も話すが、ここでは 1.1 で話す
        ...(ca ? { ca, checkServerIdentity: () => undefined } : { rejectUnauthorized: false }),
      });
      const fail = (e) => {
        sock.destroy();
        reject(e instanceof ClnError ? e : new ClnError(`CLN に接続できません: ${e.message}`, 502));
      };
      sock.setTimeout(15000, () => fail(new ClnError('CLN が応答しません（タイムアウト）', 504)));
      sock.once('error', fail);
      sock.once('secureConnect', () => {
        lastFingerprint = sock.getPeerCertificate()?.fingerprint256 || null;
        if (tlsMode === 'fingerprint' && normFp(lastFingerprint) !== normFp(clnTlsFingerprint)) {
          return fail(new ClnError(`clnrest の証明書の指紋が違います（受け取った指紋: ${lastFingerprint}）`, 502));
        }
        sock.removeListener('error', fail);
        sock.setTimeout(0);
        resolvePromise(sock);
      });
    });
  }

  async function restCall(method, params = {}) {
    let ca;
    try {
      if (clnCaCert) ca = readFileSync(clnCaCert);
    } catch (e) {
      throw new ClnError(`CA 証明書を読めません（${clnCaCert}）: ${e.message}`, 503);
    }
    if (!clnRune) throw new ClnError('CLN_RUNE が設定されていません', 503);
    const payload = Buffer.from(JSON.stringify(params));
    const sock = isHttps ? await connectTls(ca) : null;
    return new Promise((resolvePromise, reject) => {
      const req = (sock ? httpsRequest : httpRequest)(
        {
          host: base.hostname,
          port: base.port || (isHttps ? 443 : 80),
          method: 'POST',
          path: `${base.pathname.replace(/\/$/, '')}/v1/${method}`,
          agent: false,
          // 証明書は connectTls で確かめ済み。その接続をそのまま使う（ここでの確認は省く）
          ...(sock ? { createConnection: () => sock, rejectUnauthorized: false } : {}),
          timeout: 15000,
          headers: { Host: base.host, Rune: clnRune, 'Content-Type': 'application/json', 'Content-Length': payload.length, Connection: 'close' },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = text ? JSON.parse(text) : {};
            } catch {
              /* JSON 以外 */
            }
            if (res.statusCode >= 200 && res.statusCode < 300 && json) return resolvePromise(json);
            const msg = (json && (json.message || json.error)) || text || `HTTP ${res.statusCode}`;
            // rune が通らない（401/403）はアプリの設定の問題なので 502、それ以外は CLN が断った内容として 400
            reject(new ClnError(String(msg), res.statusCode === 401 || res.statusCode === 403 ? 502 : 400, json?.code));
          });
        },
      );
      req.on('timeout', () => req.destroy(new ClnError('CLN が応答しません（タイムアウト）', 504)));
      req.on('error', (e) => {
        sock?.destroy();
        reject(e instanceof ClnError ? e : new ClnError(`CLN に接続できません: ${e.message}`, 502));
      });
      req.on('close', () => sock?.destroy());
      req.write(payload);
      req.end();
    });
  }

  let rpcId = 0;
  /** lightning-rpc（JSON-RPC 2.0）を 1 回呼ぶ。呼ぶたびにつなぎ直す */
  function socketCall(method, params = {}) {
    return new Promise((resolvePromise, reject) => {
      const sock = createConnection(clnRpcSocket);
      let buf = '';
      let done = false;
      const finish = (err, value) => {
        if (done) return;
        done = true;
        sock.destroy();
        if (err) reject(err);
        else resolvePromise(value);
      };
      sock.setEncoding('utf8');
      sock.setTimeout(15000, () => finish(new ClnError('CLN が応答しません（タイムアウト）', 504)));
      sock.on('connect', () => {
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }));
      });
      sock.on('data', (d) => {
        buf += d;
        // 応答は JSON 1 つ（末尾に空行）。届ききるまで待つ
        let msg;
        try {
          msg = JSON.parse(buf);
        } catch {
          return;
        }
        if (msg.error) finish(new ClnError(String(msg.error.message ?? 'CLN のエラー'), 400, msg.error.code));
        else finish(null, msg.result ?? {});
      });
      sock.on('end', () => finish(new ClnError('CLN が応答の途中で切断しました', 502)));
      sock.on('error', (e) => {
        const why =
          e.code === 'EACCES' || e.code === 'EPERM'
            ? `CLN のソケットに接続する権限がありません（${clnRpcSocket}）。CLN と同じユーザーで動かすか、root で動かすなら DAC_OVERRIDE の特権を付けてください。いまの状態: ${describeSocketAccess(clnRpcSocket)}`
            : e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
              ? `CLN のソケットが見つかりません（${clnRpcSocket}）。CLN が起動しているか、パスが正しいか確かめてください`
              : `CLN のソケットに接続できません（${clnRpcSocket}）: ${e.message}`;
        finish(new ClnError(why, 502, undefined));
      });
    });
  }

  const call = useSocket ? socketCall : restCall;

  return {
    tlsMode,
    lastFingerprint: () => lastFingerprint,
    // ソケットで話すときは、このアプリは rune を持たない
    ownRune: () => (useSocket ? null : clnRune),
    getInfo: () => call('getinfo'),
    /** 使えるコマンド名の一覧 */
    listCommands: async () => {
      const r = await call('help');
      const names = (r.help || []).map((h) => String(h.command || '').split(/\s+/)[0]).filter(Boolean);
      return [...new Set(names)].sort();
    },
    createRune: async (restrictions) => call('createrune', { restrictions }),
    showRunes: async (rune) => (await call('showrunes', rune ? { rune } : {})).runes ?? [],
    blacklist: async ({ start, end, relist = false }) =>
      (await call('blacklistrune', { start: Number(start), end: Number(end ?? start), ...(relist ? { relist: true } : {}) })).blacklist ?? [],
    /** 試す（成功すると、その rune の使用回数が増える） */
    checkRune: async ({ rune, method, params }) => {
      try {
        const r = await call('checkrune', { rune, method, params: params ?? {} });
        return { valid: r.valid === true, reason: '' };
      } catch (e) {
        if (e.code === 1501 || e.code === 1502 || e.code === 1503) return { valid: false, reason: e.message, code: e.code };
        throw e;
      }
    },
  };
}
