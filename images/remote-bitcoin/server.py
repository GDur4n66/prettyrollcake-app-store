"""Remote Bitcoin: relay + settings UI.

Apps that depend on Bitcoin Node (LND, Core Lightning, Electrs, ...) connect
to this container's fixed IP. Each relay port forwards to the bitcoind in
SETTINGS_FILE, which is re-read for every new connection, so a new host or
port applies without restarting those apps. Saving new settings also closes
the open relay connections so that clients reconnect to the new target.

Relaying keeps the apps' traffic inside the Umbrel Docker network. Tools
that route a Lightning node's outside traffic through a VPN (TunnelSats)
leave that network alone, so a bitcoind on the LAN stays reachable.

exports.sh reads SETTINGS_FILE for the network and RPC credentials.
Standard library only.
"""

import asyncio
import base64
import json
import os
import re
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HTTP_PORT = int(os.environ.get("HTTP_PORT", "8080"))
SETTINGS_FILE = os.environ.get("SETTINGS_FILE", "/data/settings.json")
WEB_DIR = os.environ.get("WEB_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "web"))
CONNECT_TIMEOUT = 10

NETWORKS = {
    # app network -> getblockchaininfo "chain"
    "mainnet": "main",
    "testnet": "test",
    "testnet4": "testnet4",
    "signet": "signet",
    "regtest": "regtest",
}

DEFAULTS = {
    "host": "",
    "network": "mainnet",
    "rpcPort": 8332,
    "rpcUser": "",
    "rpcPass": "",
    "p2pPort": 8333,
    "zmqRawBlockPort": 28332,
    "zmqRawTxPort": 28333,
    "zmqHashBlockPort": 28334,
}
PORT_FIELDS = ["rpcPort", "p2pPort", "zmqRawBlockPort", "zmqRawTxPort", "zmqHashBlockPort"]

# (name, port this container listens on, settings field or fixed remote port).
# The listen ports are fixed and match the APP_BITCOIN_*_PORT values in exports.sh.
RELAYS = [
    ("RPC", 8332, "rpcPort"),
    ("P2P", 8333, "p2pPort"),
    ("ZMQ rawblock", 28332, "zmqRawBlockPort"),
    ("ZMQ rawtx", 28333, "zmqRawTxPort"),
    ("ZMQ hashblock", 28334, "zmqHashBlockPort"),
    ("ZMQ sequence", 28335, 28335),
    ("ZMQ hashtx", 28336, 28336),
]

# Relay status shown in the UI, per relay name
status_lock = threading.Lock()
status = {
    name: {"listen": listen, "active": 0, "total": 0, "lastError": None, "lastErrorAt": None, "lastOkAt": None}
    for name, listen, _ in RELAYS
}

# Open relay connections, so they can be closed when the target changes
relay_loop = None
open_writers = set()


def update_status(name, **changes):
    with status_lock:
        entry = status[name]
        for key, value in changes.items():
            if key in ("active", "total"):
                entry[key] += value
            else:
                entry[key] = value


def status_snapshot():
    with status_lock:
        return [dict(status[name], name=name) for name, _, _ in RELAYS]

# Values end up in LND/CLN command lines and docker compose files,
# so only allow characters that need no quoting there.
HOST_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$")
USER_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
PASS_RE = re.compile(r"^[A-Za-z0-9._~+/=:@%^*,-]{1,256}$")


def load_settings():
    settings = dict(DEFAULTS)
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            saved = json.load(f)
        if isinstance(saved, dict):
            settings.update({k: saved[k] for k in DEFAULTS if k in saved})
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        pass
    return settings


def save_settings(settings):
    directory = os.path.dirname(SETTINGS_FILE)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".settings.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2)
            f.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, SETTINGS_FILE)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def validate(data, current):
    """Return (settings, errors). An empty rpcPass keeps the saved one."""
    errors = {}
    s = {}

    host = str(data.get("host", "")).strip()
    if not HOST_RE.match(host):
        errors["host"] = "IPv4 アドレスかホスト名を入れてください（英数字・ドット・ハイフンのみ）"
    s["host"] = host

    network = str(data.get("network", ""))
    if network not in NETWORKS:
        errors["network"] = "ネットワークを選んでください"
    s["network"] = network

    user = str(data.get("rpcUser", "")).strip()
    if not USER_RE.match(user):
        errors["rpcUser"] = "英数字と . _ - のみ、64文字まで"
    s["rpcUser"] = user

    password = str(data.get("rpcPass", ""))
    if password == "":
        password = current.get("rpcPass", "")
        if not password:
            errors["rpcPass"] = "パスワードを入れてください"
    elif not PASS_RE.match(password):
        errors["rpcPass"] = "使えない文字があります（空白・引用符・$・\\・# などは不可）"
    s["rpcPass"] = password

    for field in PORT_FIELDS:
        try:
            value = int(data.get(field, DEFAULTS[field]))
            if not 1 <= value <= 65535:
                raise ValueError
            s[field] = value
        except (TypeError, ValueError):
            errors[field] = "1〜65535 のポート番号を入れてください"
    return s, errors


def rpc(settings, method, params=None, timeout=6):
    url = f"http://{settings['host']}:{settings['rpcPort']}/"
    body = json.dumps({"jsonrpc": "1.0", "id": "remote-bitcoin", "method": method, "params": params or []})
    token = base64.b64encode(f"{settings['rpcUser']}:{settings['rpcPass']}".encode()).decode()
    req = urllib.request.Request(
        url,
        data=body.encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Basic {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise RuntimeError("認証に失敗しました（ユーザー名かパスワードが違います）") from None
        if e.code == 403:
            raise RuntimeError("拒否されました（bitcoin.conf の rpcallowip に Umbrel の IP が入っているか確認）") from None
        try:
            payload = json.load(e)
        except ValueError:
            raise RuntimeError(f"HTTP {e.code}") from None
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, "reason", e)
        raise RuntimeError(f"接続できません: {reason}") from None
    if payload.get("error"):
        raise RuntimeError(payload["error"].get("message", str(payload["error"])))
    return payload.get("result")


def tcp_check(host, port, timeout=3):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return None
    except OSError as e:
        return str(e)


def run_test(settings):
    result = {"rpc": None, "zmq": []}

    try:
        info = rpc(settings, "getblockchaininfo")
    except RuntimeError as e:
        result["rpc"] = {"ok": False, "error": str(e)}
        return result

    expected_chain = NETWORKS[settings["network"]]
    result["rpc"] = {
        "ok": True,
        "chain": info.get("chain"),
        "chainMatches": info.get("chain") == expected_chain,
        "expectedChain": expected_chain,
        "blocks": info.get("blocks"),
        "headers": info.get("headers"),
        "verificationProgress": info.get("verificationprogress"),
        "initialBlockDownload": info.get("initialblockdownload"),
        "pruned": info.get("pruned"),
    }
    try:
        result["rpc"]["version"] = rpc(settings, "getnetworkinfo").get("subversion")
    except RuntimeError:
        pass

    # Fulcrum and ElectrumX need txindex
    try:
        indexes = rpc(settings, "getindexinfo") or {}
        txindex = indexes.get("txindex")
        result["rpc"]["txindex"] = bool(txindex)
        result["rpc"]["txindexSynced"] = bool(txindex and txindex.get("synced"))
    except RuntimeError:
        pass

    # Electrs downloads blocks over P2P
    result["p2p"] = {"port": settings["p2pPort"], "error": tcp_check(settings["host"], settings["p2pPort"])}

    # What the remote node publishes, if it allows the call
    published = {}
    try:
        for n in rpc(settings, "getzmqnotifications") or []:
            published[n.get("type")] = n.get("address")
    except RuntimeError:
        published = None

    for label, field, ztype in [
        ("rawblock", "zmqRawBlockPort", "pubrawblock"),
        ("rawtx", "zmqRawTxPort", "pubrawtx"),
    ]:
        port = settings[field]
        entry = {"name": label, "port": port, "error": tcp_check(settings["host"], port)}
        if published is not None:
            address = published.get(ztype)
            entry["published"] = address
            entry["portMatches"] = bool(address) and address.rsplit(":", 1)[-1] == str(port)
        result["zmq"].append(entry)
    return result


# ---------- relay ----------

def remote_port(settings, target):
    return target if isinstance(target, int) else settings[target]


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


def make_handler(name, target):
    async def handle_client(client_reader, client_writer):
        settings = load_settings()
        update_status(name, active=1, total=1)
        open_writers.add(client_writer)
        remote_writer = None
        try:
            if not settings.get("host"):
                update_status(name, lastError="接続先が設定されていません", lastErrorAt=time.time())
                return
            port = remote_port(settings, target)
            try:
                remote_reader, remote_writer = await asyncio.wait_for(
                    asyncio.open_connection(settings["host"], port), timeout=CONNECT_TIMEOUT
                )
            except (OSError, asyncio.TimeoutError) as e:
                update_status(name, lastError=f"{settings['host']}:{port} に接続できません: {e or 'タイムアウト'}",
                              lastErrorAt=time.time())
                return
            open_writers.add(remote_writer)
            update_status(name, lastOkAt=time.time())
            await asyncio.gather(pipe(client_reader, remote_writer), pipe(remote_reader, client_writer))
        finally:
            update_status(name, active=-1)
            open_writers.discard(client_writer)
            open_writers.discard(remote_writer)
            for w in (client_writer, remote_writer):
                if w is not None:
                    try:
                        w.close()
                    except Exception:
                        pass

    return handle_client


def close_all_connections():
    for w in list(open_writers):
        try:
            w.close()
        except Exception:
            pass


def target_of(settings):
    return [settings.get("host")] + [remote_port(settings, t) for _, _, t in RELAYS]


async def run_relays():
    global relay_loop
    relay_loop = asyncio.get_running_loop()
    servers = [await asyncio.start_server(make_handler(name, target), "0.0.0.0", listen)
               for name, listen, target in RELAYS]
    await asyncio.gather(*(s.serve_forever() for s in servers))


def public_settings(settings):
    out = {k: v for k, v in settings.items() if k != "rpcPass"}
    out["hasPassword"] = bool(settings.get("rpcPass"))
    out["configured"] = os.path.exists(SETTINGS_FILE)
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "RemoteBitcoin"

    def log_message(self, fmt, *args):
        pass

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        # Only accept JSON with a custom header, so a plain cross-site form cannot post here.
        if self.headers.get("X-Requested-With") != "remote-bitcoin":
            return None
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return None
        length = int(self.headers.get("Content-Length") or 0)
        if length > 16384:
            return None
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            with open(os.path.join(WEB_DIR, "index.html"), "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/settings":
            self.send_json(200, public_settings(load_settings()))
        elif self.path == "/api/status":
            self.send_json(200, {"relays": status_snapshot(), "now": time.time()})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        data = self.read_json()
        if data is None:
            self.send_json(400, {"error": "bad request"})
            return
        current = load_settings()
        settings, errors = validate(data, current)
        if errors:
            self.send_json(400, {"errors": errors})
            return

        if self.path == "/api/settings":
            try:
                save_settings(settings)
            except OSError as e:
                self.send_json(500, {"error": f"保存できません: {e}"})
                return
            # Reconnect clients that are still talking to the old target
            if target_of(current) != target_of(settings) and relay_loop is not None:
                relay_loop.call_soon_threadsafe(close_all_connections)
            restart_needed = any(current.get(k) != settings[k] for k in ("network", "rpcUser", "rpcPass"))
            self.send_json(200, dict(public_settings(settings), restartNeeded=restart_needed))
        elif self.path == "/api/test":
            self.send_json(200, run_test(settings))
        else:
            self.send_json(404, {"error": "not found"})


def run_http():
    ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), Handler).serve_forever()


if __name__ == "__main__":
    threading.Thread(target=run_http, daemon=True).start()
    asyncio.run(run_relays())
