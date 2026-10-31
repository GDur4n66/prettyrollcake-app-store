"""Remote Electrum: relay + settings UI.

Apps that depend on Electrs connect to this container's relay port over plain
TCP. Each connection is forwarded to the Electrum server in SETTINGS_FILE,
over TCP or SSL. Settings are re-read for every new connection, so changes
apply without restarting the apps. Standard library only.
"""

import asyncio
import json
import os
import re
import socket
import ssl
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HTTP_PORT = int(os.environ.get("HTTP_PORT", "8080"))
RELAY_PORT = int(os.environ.get("RELAY_PORT", "50001"))
SETTINGS_FILE = os.environ.get("SETTINGS_FILE", "/data/settings.json")
HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULTS = {"host": "", "port": 50001, "protocol": "tcp", "verifyCert": False}
HOST_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$")
CONNECT_TIMEOUT = 10

GENESIS = {
    "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f": "mainnet",
    "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943": "testnet",
    "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043": "testnet4",
    "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6": "signet",
    "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206": "regtest",
}

# Relay status shown in the UI
status_lock = threading.Lock()
status = {"active": 0, "total": 0, "lastError": None, "lastErrorAt": None, "lastOkAt": None}


def update_status(**changes):
    with status_lock:
        for key, value in changes.items():
            if key in ("active", "total"):
                status[key] += value
            else:
                status[key] = value


# ---------- settings ----------

def load_settings():
    settings = dict(DEFAULTS)
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            saved = json.load(f)
        if isinstance(saved, dict):
            settings.update({k: saved[k] for k in DEFAULTS if k in saved})
    except (OSError, ValueError):
        pass
    return settings


def is_configured(settings):
    return bool(settings.get("host"))


def save_settings(settings):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(SETTINGS_FILE), prefix=".settings.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2)
            f.write("\n")
        os.replace(tmp, SETTINGS_FILE)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def validate(data):
    errors = {}
    host = str(data.get("host", "")).strip()
    if not HOST_RE.match(host):
        errors["host"] = "IPv4 アドレスかホスト名を入れてください（英数字・ドット・ハイフンのみ）"
    protocol = str(data.get("protocol", ""))
    if protocol not in ("tcp", "ssl"):
        errors["protocol"] = "TCP か SSL を選んでください"
    try:
        port = int(data.get("port"))
        if not 1 <= port <= 65535:
            raise ValueError
    except (TypeError, ValueError):
        port = None
        errors["port"] = "1〜65535 のポート番号を入れてください"
    settings = {"host": host, "port": port, "protocol": protocol, "verifyCert": bool(data.get("verifyCert"))}
    return settings, errors


def ssl_context(settings):
    ctx = ssl.create_default_context()
    if not settings.get("verifyCert"):
        # Electrum servers usually use self-signed certificates
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


# ---------- relay ----------

async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError, asyncio.IncompleteReadError, ssl.SSLError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle_client(client_reader, client_writer):
    settings = load_settings()
    update_status(active=1, total=1)
    try:
        if not is_configured(settings):
            update_status(lastError="接続先が設定されていません", lastErrorAt=time.time())
            return
        use_ssl = settings["protocol"] == "ssl"
        try:
            remote_reader, remote_writer = await asyncio.wait_for(
                asyncio.open_connection(
                    settings["host"],
                    settings["port"],
                    ssl=ssl_context(settings) if use_ssl else None,
                    server_hostname=settings["host"] if use_ssl else None,
                ),
                timeout=CONNECT_TIMEOUT,
            )
        except (OSError, asyncio.TimeoutError, ssl.SSLError) as e:
            update_status(lastError=f"{settings['host']}:{settings['port']} に接続できません: {e or 'タイムアウト'}",
                          lastErrorAt=time.time())
            return
        update_status(lastOkAt=time.time())
        await asyncio.gather(pipe(client_reader, remote_writer), pipe(remote_reader, client_writer))
    finally:
        update_status(active=-1)
        try:
            client_writer.close()
        except Exception:
            pass


async def run_relay():
    server = await asyncio.start_server(handle_client, "0.0.0.0", RELAY_PORT)
    async with server:
        await server.serve_forever()


# ---------- connection test ----------

def electrum_call(settings, timeout=10):
    """Connect, run a few Electrum protocol calls, return the results."""
    started = time.monotonic()
    raw = socket.create_connection((settings["host"], settings["port"]), timeout=timeout)
    try:
        if settings["protocol"] == "ssl":
            sock = ssl_context(settings).wrap_socket(raw, server_hostname=settings["host"])
        else:
            sock = raw
        sock.settimeout(timeout)
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "server.version", "params": ["remote-electrum-test", "1.4"]},
            {"jsonrpc": "2.0", "id": 2, "method": "server.features", "params": []},
            {"jsonrpc": "2.0", "id": 3, "method": "blockchain.headers.subscribe", "params": []},
        ]
        sock.sendall(b"".join(json.dumps(r).encode() + b"\n" for r in requests))
        buffer = b""
        replies = {}
        while len(replies) < len(requests):
            chunk = sock.recv(65536)
            if not chunk:
                raise ConnectionError("サーバが接続を閉じました")
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if not line.strip():
                    continue
                msg = json.loads(line)
                if msg.get("id") in (1, 2, 3):
                    replies[msg["id"]] = msg
        elapsed = time.monotonic() - started
        return replies, elapsed
    finally:
        raw.close()


def run_test(settings):
    # When the port and protocol do not match, TCP to an SSL port usually gets
    # the connection closed, and SSL to a TCP port usually hangs.
    mismatch_hint = (
        "（TCP のポートに SSL でつないでいませんか？）" if settings["protocol"] == "ssl"
        else "（SSL のポートに TCP でつないでいませんか？）"
    )
    try:
        replies, elapsed = electrum_call(settings)
    except ssl.SSLCertVerificationError as e:
        return {"ok": False, "error": f"証明書を検証できません（自己署名なら「証明書を検証する」を外す）: {e.verify_message}"}
    except ssl.SSLError as e:
        return {"ok": False, "error": f"SSL で接続できません{mismatch_hint}: {e}"}
    except socket.timeout:
        return {"ok": False, "error": f"応答がありません{mismatch_hint}"}
    except ConnectionRefusedError:
        return {"ok": False, "error": "接続を拒否されました（ポート番号と、サーバが外からの接続を受け付けているか確認）"}
    except ConnectionError:
        return {"ok": False, "error": f"サーバが接続を切りました{mismatch_hint}"}
    except (OSError, ValueError) as e:
        return {"ok": False, "error": f"接続できません: {e}"}

    for msg in replies.values():
        if msg.get("error"):
            return {"ok": False, "error": f"サーバがエラーを返しました: {msg['error']}"}
    version = replies[1].get("result") or []
    features = replies[2].get("result") or {}
    header = replies[3].get("result") or {}
    genesis = features.get("genesis_hash")
    return {
        "ok": True,
        "software": features.get("server_version") or (version[0] if version else None),
        "protocol": version[1] if len(version) > 1 else None,
        "network": GENESIS.get(genesis, "不明"),
        "height": header.get("height"),
        "ms": round(elapsed * 1000),
    }


# ---------- web UI ----------

def public_settings(settings):
    out = dict(settings)
    out["configured"] = is_configured(settings)
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "RemoteElectrum"

    def log_message(self, fmt, *args):
        pass

    def send_json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        # Only accept JSON with a custom header, so a plain cross-site form cannot post here.
        if self.headers.get("X-Requested-With") != "remote-electrum":
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
            with open(os.path.join(HERE, "index.html"), "rb") as f:
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
            with status_lock:
                self.send_json(200, dict(status, now=time.time()))
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        data = self.read_json()
        if data is None:
            self.send_json(400, {"error": "bad request"})
            return
        settings, errors = validate(data)
        if errors:
            self.send_json(400, {"errors": errors})
            return
        if self.path == "/api/settings":
            try:
                save_settings(settings)
            except OSError as e:
                self.send_json(500, {"error": f"保存できません: {e}"})
                return
            self.send_json(200, public_settings(settings))
        elif self.path == "/api/test":
            self.send_json(200, run_test(settings))
        else:
            self.send_json(404, {"error": "not found"})


def run_http():
    ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), Handler).serve_forever()


if __name__ == "__main__":
    threading.Thread(target=run_http, daemon=True).start()
    asyncio.run(run_relay())
