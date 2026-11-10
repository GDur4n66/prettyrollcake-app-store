// LND の REST API（macaroon まわりだけ）
import { request } from 'node:https';
import { readFileSync } from 'node:fs';

export class LndError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// 証明書と macaroon は呼ぶたびに読む（LND の再起動で作り直されることがあり、
// Umbrel ではウォレットのロック解除まで macaroon が無いため）
function readOrExplain(path, what) {
  try {
    return readFileSync(path);
  } catch (e) {
    throw new LndError(
      e.code === 'ENOENT'
        ? `${what}が見つかりません（${path}）。LND が起動中か、ウォレットのロックが解除されていない可能性があります`
        : `${what}を読めません（${path}）: ${e.message}`,
      503,
    );
  }
}

export function createLnd({ lndRestUrl, lndTlsCert, lndMacaroon, lndTlsVerifyHostname = true }) {
  const base = new URL(lndRestUrl);
  const ownMacaroon = () => readOrExplain(lndMacaroon, 'LND の macaroon ');

  function call(method, path, body) {
    let ca, macHex;
    try {
      ca = readOrExplain(lndTlsCert, 'LND の TLS 証明書');
      macHex = ownMacaroon().toString('hex');
    } catch (e) {
      return Promise.reject(e);
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolvePromise, reject) => {
      const req = request(
        {
          host: base.hostname,
          port: base.port || 443,
          method,
          path,
          ca,
          // 証明書そのものを信頼先にしているので、ホスト名の確認を省いても別の相手にはつながらない
          ...(lndTlsVerifyHostname ? {} : { checkServerIdentity: () => undefined }),
          timeout: 15000,
          headers: {
            'Grpc-Metadata-macaroon': macHex,
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          },
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
            if (res.statusCode >= 200 && res.statusCode < 300 && json) resolvePromise(json);
            else reject(new LndError((json && (json.message || json.error)) || text || `HTTP ${res.statusCode}`, res.statusCode));
          });
        },
      );
      req.on('timeout', () => req.destroy(new LndError('LND が応答しません（タイムアウト）', 504)));
      req.on('error', (e) => reject(e instanceof LndError ? e : new LndError(`LND に接続できません: ${e.message}`, 502)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    /** アプリ自身の macaroon（読めなければ null） */
    ownMacaroonHex: () => {
      try {
        return ownMacaroon().toString('hex');
      } catch {
        return null;
      }
    },
    getInfo: () => call('GET', '/v1/getinfo'),
    listIds: async () => (await call('GET', '/v1/macaroon/ids')).root_key_ids?.map(String) ?? [],
    listPermissions: async () => (await call('GET', '/v1/macaroon/permissions')).method_permissions ?? {},
    bake: async ({ rootKeyId, permissions, allowExternal = false }) =>
      (
        await call('POST', '/v1/macaroon', {
          root_key_id: String(rootKeyId),
          permissions,
          allow_external_permissions: allowExternal,
        })
      ).macaroon,
    deleteId: async (rootKeyId) => (await call('DELETE', `/v1/macaroon/${encodeURIComponent(String(rootKeyId))}`)).deleted === true,
    checkPermissions: async ({ macaroonBytes, permissions, fullMethod }) =>
      (
        await call('POST', '/v1/macaroon/checkpermissions', {
          macaroon: Buffer.from(macaroonBytes).toString('base64'),
          permissions,
          fullMethod,
        })
      ).valid === true,
  };
}
