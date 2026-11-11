"""btcd for Umbrel.

Two modes, one per service of the app:

  python -I /app/btcdapp.py launcher
      Builds the btcd flags from SETTINGS_FILE and runs btcd. When btcd exits
      cleanly (the "stop" RPC, sent by the web UI after the settings change),
      it starts btcd again with the new settings. SIGTERM/SIGINT stop btcd and
      then the launcher.

  python -I /app/btcdapp.py web
      Status page and settings. Talks to btcd over its RPC (TLS, rpc.cert).

Standard library only.
"""

import base64
import json
import os
import signal
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BTCD_DIR = os.environ.get("BTCD_DIR", "/data/btcd")
SETTINGS_FILE = os.environ.get("SETTINGS_FILE", "/data/settings.json")
# Written by the launcher each time it starts btcd: the settings in use
APPLIED_FILE = os.path.join(BTCD_DIR, "applied-settings.json")
CERT_FILE = os.path.join(BTCD_DIR, "rpc.cert")
KEY_FILE = os.path.join(BTCD_DIR, "rpc.key")
CONF_FILE = os.path.join(BTCD_DIR, "btcd.conf")

RPC_USER = os.environ.get("BTCD_RPC_USER", "umbrel")
RPC_PASS = os.environ.get("BTCD_RPC_PASS", "")
# Ports inside the container. They stay the same on every network.
P2P_PORT = 8333
RPC_PORT = 8334

NETWORKS = {
    # name: (btcd flag, default P2P port used by peers, label)
    "mainnet": (None, 8333, "メインネット"),
    "testnet4": ("--testnet4", 48333, "テストネット4"),
    "testnet": ("--testnet", 18333, "テストネット3"),
    "signet": ("--signet", 38333, "シグネット"),
}
DEFAULTS = {
    "network": "mainnet",
    "torOnly": False,
    "txindex": True,
    "addrindex": False,
    "utxoCacheMiB": 250,
}
UTXO_CACHE_RANGE = (50, 16000)


# ---------------------------------------------------------------- settings

def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def write_json(path, data):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp.", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def validate(data):
    """Return (settings, error). Unknown keys are ignored."""
    s = dict(DEFAULTS)
    if not isinstance(data, dict):
        return None, "設定の形式が正しくありません"
    if "network" in data:
        if data["network"] not in NETWORKS:
            return None, "ネットワークの値が正しくありません"
        s["network"] = data["network"]
    for key in ("torOnly", "txindex", "addrindex"):
        if key in data:
            if not isinstance(data[key], bool):
                return None, f"{key} の値が正しくありません"
            s[key] = data[key]
    if "utxoCacheMiB" in data:
        v = data["utxoCacheMiB"]
        lo, hi = UTXO_CACHE_RANGE
        if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
            return None, f"UTXO キャッシュは {lo}〜{hi} MiB の整数で指定してください"
        s["utxoCacheMiB"] = v
    if s["addrindex"]:
        # btcd turns on txindex itself when addrindex is on
        s["txindex"] = True
    return s, None


def load_settings():
    saved = read_json(SETTINGS_FILE)
    if saved is None:
        return dict(DEFAULTS)
    s, err = validate(saved)
    if err:
        print(f"settings.json: {err}. Using the defaults.", file=sys.stderr, flush=True)
        return dict(DEFAULTS)
    return s


def onion_address():
    onion = os.environ.get("BTCD_P2P_ONION", "").strip()
    if onion.endswith(".onion") and onion != "notyetset.onion":
        return onion
    return ""


# ---------------------------------------------------------------- launcher

def btcd_args(s):
    flag, peer_port, _ = NETWORKS[s["network"]]
    tor = os.environ.get("BTCD_TOR_PROXY", "")
    args = [
        f"--configfile={CONF_FILE}",
        f"--datadir={os.path.join(BTCD_DIR, 'data')}",
        f"--logdir={os.path.join(BTCD_DIR, 'logs')}",
        f"--rpccert={CERT_FILE}",
        f"--rpckey={KEY_FILE}",
        f"--listen=0.0.0.0:{P2P_PORT}",
        f"--rpclisten=0.0.0.0:{RPC_PORT}",
        f"--rpcuser={RPC_USER}",
        f"--rpcpass={RPC_PASS}",
        f"--utxocachemaxsize={s['utxoCacheMiB']}",
    ]
    if flag:
        args.append(flag)
    for net in filter(None, os.environ.get("BTCD_WHITELIST", "").split(",")):
        args.append(f"--whitelist={net.strip()}")
    if tor:
        # .onion peers always go through Tor; with torOnly everything does
        args.append(f"--onion={tor}")
        if s["torOnly"]:
            args.append(f"--proxy={tor}")
        onion = onion_address()
        if onion:
            args.append(f"--externalip={onion}:{peer_port}")
    if s["txindex"]:
        args.append("--txindex")
    if s["addrindex"]:
        args.append("--addrindex")
    return args


def run_launcher():
    if not RPC_PASS:
        print("BTCD_RPC_PASS is not set", file=sys.stderr)
        return 2
    os.makedirs(BTCD_DIR, exist_ok=True)
    if not os.path.exists(CONF_FILE):
        # btcd writes a sample config with a random RPC login when the file is
        # missing. The flags set everything, so keep an empty one instead.
        with open(CONF_FILE, "w", encoding="utf-8") as f:
            f.write("; Extra btcd options can go here. The app's settings\n"
                    "; (command line flags) take precedence over this file.\n")

    stopping = threading.Event()
    proc = None

    def on_signal(signum, _frame):
        stopping.set()
        if proc and proc.poll() is None:
            proc.send_signal(signal.SIGINT)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    while not stopping.is_set():
        s = load_settings()
        args = btcd_args(s)
        shown = [a if not a.startswith("--rpcpass=") else "--rpcpass=***" for a in args]
        print("Starting btcd " + " ".join(shown), flush=True)
        write_json(APPLIED_FILE, {**s, "onion": onion_address(), "startedAt": int(time.time())})
        proc = subprocess.Popen(["btcd", *args])
        if stopping.is_set():
            proc.send_signal(signal.SIGINT)
        rc = proc.wait()
        if stopping.is_set():
            print(f"btcd stopped ({rc})", flush=True)
            return 0
        if rc != 0:
            print(f"btcd exited with {rc}", file=sys.stderr, flush=True)
            return rc
        # Clean exit without a signal: the "stop" RPC. Start again.
        print("btcd stopped by RPC. Restarting with the saved settings.", flush=True)
        time.sleep(1)
    return 0


# ---------------------------------------------------------------- RPC

RPC_URL = os.environ.get("BTCD_RPC_URL", f"https://btcd:{RPC_PORT}")


class RpcError(Exception):
    pass


def rpc(method, params=None, timeout=10):
    if not os.path.exists(CERT_FILE):
        raise RpcError("btcd の起動を待っています（証明書がまだありません）")
    ctx = ssl.create_default_context(cafile=CERT_FILE)
    # The certificate names the Umbrel host, not the service name used here
    ctx.check_hostname = False
    body = json.dumps({"jsonrpc": "1.0", "id": method, "method": method,
                       "params": params or []}).encode()
    auth = base64.b64encode(f"{RPC_USER}:{RPC_PASS}".encode()).decode()
    req = urllib.request.Request(RPC_URL, data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Basic " + auth})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            data = json.load(e)
        except ValueError:
            raise RpcError(f"RPC エラー（HTTP {e.code}）") from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        reason = getattr(e, "reason", e)
        raise RpcError(f"btcd に接続できません（{reason}）") from None
    if data.get("error"):
        raise RpcError(data["error"].get("message", "RPC エラー"))
    return data.get("result")


# ---------------------------------------------------------------- web

WEB_DIR = os.environ.get("WEB_DIR", "/web")
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
}

_size_cache = {"at": 0.0, "bytes": None, "busy": False}


def data_size():
    """Size of the block data, computed in the background (it can be large)."""
    now = time.time()
    if not _size_cache["busy"] and now - _size_cache["at"] > 300:
        _size_cache["busy"] = True

        def work():
            total = 0
            for root, _dirs, files in os.walk(os.path.join(BTCD_DIR, "data")):
                for name in files:
                    try:
                        total += os.lstat(os.path.join(root, name)).st_size
                    except OSError:
                        pass
            _size_cache.update(at=time.time(), bytes=total, busy=False)

        threading.Thread(target=work, daemon=True).start()
    return _size_cache["bytes"]


def status():
    saved = load_settings()
    applied = read_json(APPLIED_FILE) or {}
    pending = any(applied.get(k) != saved[k] for k in DEFAULTS) if applied else False
    out = {
        "settings": saved,
        "applied": {k: applied.get(k) for k in DEFAULTS} if applied else None,
        "pendingRestart": pending,
        "networks": {k: v[2] for k, v in NETWORKS.items()},
        "utxoCacheRange": UTXO_CACHE_RANGE,
        "connect": {
            "host": os.environ.get("DEVICE_DOMAIN_NAME", "umbrel.local"),
            "rpcPort": int(os.environ.get("BTCD_RPC_HOST_PORT", "48334")),
            "p2pPort": int(os.environ.get("BTCD_P2P_HOST_PORT", "48333")),
            "rpcUser": RPC_USER,
            "rpcPass": RPC_PASS,
            "onion": onion_address(),
            "onionPort": NETWORKS[applied.get("network", saved["network"])][1],
            "internalIp": os.environ.get("BTCD_INTERNAL_IP", ""),
        },
        "dataBytes": data_size(),
    }
    try:
        info = rpc("getinfo")
        chain = rpc("getblockchaininfo")
        header = rpc("getblockheader", [chain["bestblockhash"], True])
        peers = rpc("getpeerinfo") or []
        out["node"] = {
            "version": info.get("version"),
            "protocolVersion": info.get("protocolversion"),
            "chain": chain.get("chain"),
            "blocks": chain.get("blocks"),
            "headers": chain.get("headers"),
            "bestBlockHash": chain.get("bestblockhash"),
            "bestBlockTime": header.get("time"),
            "difficulty": chain.get("difficulty"),
            "peers": len(peers),
            "inbound": sum(1 for p in peers if p.get("inbound")),
            "onionPeers": sum(1 for p in peers if ".onion" in str(p.get("addr", ""))),
            "proxy": info.get("proxy") or "",
            "uptime": rpc("uptime"),
        }
    except RpcError as e:
        out["node"] = None
        out["error"] = str(e)
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "btcd-umbrel"

    def log_message(self, fmt, *args):
        pass

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/status":
            return self.send_json(200, status())
        if path == "/api/rpc.cert":
            try:
                with open(CERT_FILE, "rb") as f:
                    body = f.read()
            except OSError:
                return self.send_json(404, {"error": "証明書はまだ作られていません"})
            self.send_response(200)
            self.send_header("Content-Type", "application/x-pem-file")
            self.send_header("Content-Disposition", 'attachment; filename="btcd-rpc.cert"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path in STATIC:
            name, ctype = STATIC[path]
            try:
                with open(os.path.join(WEB_DIR, name), "rb") as f:
                    body = f.read()
            except OSError:
                return self.send_json(404, {"error": "not found"})
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_json(404, {"error": "not found"})

    def read_json_body(self):
        # A JSON content type makes cross-site form posts impossible
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            return None
        length = int(self.headers.get("Content-Length") or 0)
        if length > 10000:
            return None
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return None

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        data = self.read_json_body()
        if data is None:
            return self.send_json(400, {"error": "リクエストが正しくありません"})
        if path == "/api/settings":
            s, err = validate(data.get("settings"))
            if err:
                return self.send_json(400, {"error": err})
            write_json(SETTINGS_FILE, s)
            restarted = False
            if data.get("restart"):
                try:
                    rpc("stop")
                    restarted = True
                except RpcError as e:
                    return self.send_json(502, {"error": f"保存しましたが再起動できませんでした: {e}"})
            return self.send_json(200, {"ok": True, "restarted": restarted})
        if path == "/api/restart":
            try:
                rpc("stop")
            except RpcError as e:
                return self.send_json(502, {"error": str(e)})
            return self.send_json(200, {"ok": True})
        self.send_json(404, {"error": "not found"})


def run_web():
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Listening on :{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "web"
    if mode == "launcher":
        sys.exit(run_launcher())
    if mode == "web":
        run_web()
    else:
        print("usage: btcdapp.py launcher|web", file=sys.stderr)
        sys.exit(2)
