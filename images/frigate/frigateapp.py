"""Frigate for Umbrel.

  python3 -I /app/frigateapp.py

Writes config.toml on the first start (and applies the app's small
migrations), runs Frigate as a child process, and serves a status page on
PORT. The page reads Frigate's stdout (indexing progress, which compute
backend it chose, recent log lines) and its admin port's getinfo. The admin
port is bound to the loopback address only, which is why the page runs in
the same container.

The page can change where the index starts ([index] startHeight). Frigate
only ever extends its index from the last indexed block, so a new start
height means a new index: this process stops Frigate, deletes the index and
starts Frigate again.

SIGTERM/SIGINT stop Frigate and then this process; when Frigate exits on its
own, this process exits with its code.

Standard library only.
"""

import collections
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FRIGATE_BIN = "/opt/frigate/bin/frigate"
DATA_DIR = os.environ.get("FRIGATE_HOME", "/data")
NETWORK = os.environ.get("APP_BITCOIN_NETWORK", "mainnet") or "mainnet"
VERSION = os.environ.get("FRIGATE_VERSION", "")
WEB_DIR = os.environ.get("WEB_DIR", "/web")
PORT = int(os.environ.get("PORT", "50012"))
ELECTRUM_PORT = 50011
ADMIN_PORT = 50003
LOG_LINES = 200
# Frigate's own default when startHeight is not set (Taproot activation)
DEFAULT_START_HEIGHT = 709632 if NETWORK == "mainnet" else 0
MAX_START_HEIGHT = 10_000_000

# Frigate keeps mainnet in its home folder and the others in a subfolder
NETWORK_DIRS = {
    "mainnet": "",
    "testnet": "testnet3",
    "testnet4": "testnet4",
    "signet": "signet",
    "regtest": "regtest",
}
NETWORK_LABELS = {
    "mainnet": "メインネット",
    "testnet": "テストネット3",
    "testnet4": "テストネット4",
    "signet": "シグネット",
    "regtest": "regtest",
}

# Clients on these networks are exempt from the per-IP limits, the batch cap
# and pacing (README "Limits": add your LAN for a home server).
EXCLUDED_SUBNETS = ["127.0.0.1/32", "::1/128", "10.0.0.0/8", "172.16.0.0/12",
                    "192.168.0.0/16", "fc00::/7"]


def network_dir():
    sub = NETWORK_DIRS.get(NETWORK, NETWORK)
    return os.path.join(DATA_DIR, sub) if sub else DATA_DIR


def config_path():
    return os.path.join(network_dir(), "config.toml")


# ---------------------------------------------------------------- config

def new_config():
    env = os.environ.get
    node = env("APP_BITCOIN_NODE_IP", "")
    return f"""[core]
connect = true
server = "http://{node}:{env("APP_BITCOIN_RPC_PORT", "")}"
authType = "USERPASS"
auth = "{env("APP_BITCOIN_RPC_USER", "")}:{env("APP_BITCOIN_RPC_PASS", "")}"
zmqSequenceEndpoint = "tcp://{node}:{env("APP_BITCOIN_ZMQ_SEQUENCE_PORT", "")}"

[index]
cacheSize = "1M"

[scan]
computeBackend = "AUTO"
batchSize = 100000
memoryLimit = "2GB"
dbThreads = 4

[server]
host = "tcp://{env("DEVICE_DOMAIN_NAME", "umbrel.local")}:{ELECTRUM_PORT}"
tcp = "tcp://0.0.0.0:{ELECTRUM_PORT}"
adminPort = {ADMIN_PORT}
backendElectrumServer = "tcp://{env("APP_ELECTRS_NODE_IP", "")}:{env("APP_ELECTRS_NODE_PORT", "")}"

[limits]
excludedSubnets = {json.dumps(EXCLUDED_SUBNETS)}
"""


def migrate(text):
    """Bring a config written by an older version of the app up to date.
    Each step only touches the exact line the app wrote, so hand edits stay."""
    steps = [
        ('tcp = "tcp://0.0.0.0:50001"', f'tcp = "tcp://0.0.0.0:{ELECTRUM_PORT}"'),
        ('cacheSize = "2M"', 'cacheSize = "1M"'),
        ('memoryLimit = "3GB"', 'memoryLimit = "2GB"'),
    ]
    for old, new in steps:
        text = re.sub(r"(?m)^" + re.escape(old) + r"[ \t]*$", new, text)
    if not re.search(r"(?m)^\s*batchSize\s*=", text):
        text = re.sub(r'(?m)^(computeBackend = "AUTO")[ \t]*$', r"\1\nbatchSize = 100000", text, count=1)
    # 1.6.0: the status page reads getinfo from the admin port
    if not re.search(r"(?m)^\s*adminPort\s*=", text):
        text = re.sub(r"(?m)^\[server\][ \t]*$", f"[server]\nadminPort = {ADMIN_PORT}", text, count=1)
    # 1.6.0: limits for public servers; this one is a home server
    if not re.search(r"(?m)^\[limits\][ \t]*$", text):
        text = text.rstrip("\n") + f"\n\n[limits]\nexcludedSubnets = {json.dumps(EXCLUDED_SUBNETS)}\n"
    return text


def prepare_config():
    os.umask(0o077)
    os.makedirs(network_dir(), exist_ok=True)
    path = config_path()
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_config())
        print(f"Wrote {path}", flush=True)
        return
    with open(path, encoding="utf-8") as f:
        old = f.read()
    new = migrate(old)
    if new != old:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(new)
        os.replace(tmp, path)
        print(f"Updated {path}", flush=True)


def read_config():
    try:
        with open(config_path(), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def write_config(text):
    path = config_path()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def section_bounds(text, name):
    """(start, end) of a TOML section's body, or None when it is missing."""
    m = re.search(r"(?m)^\[" + re.escape(name) + r"\][ \t]*\n?", text)
    if not m:
        return None
    nxt = re.search(r"(?m)^\[", text[m.end():])
    return m.end(), m.end() + nxt.start() if nxt else len(text)


def start_height():
    """The configured start height, or None for Frigate's default."""
    text = read_config()
    b = section_bounds(text, "index")
    if not b:
        return None
    m = re.search(r"(?m)^[ \t]*startHeight[ \t]*=[ \t]*(\d+)", text[b[0]:b[1]])
    return int(m.group(1)) if m else None


def set_start_height(height):
    text = read_config()
    line = f"startHeight = {height}\n" if height is not None else ""
    b = section_bounds(text, "index")
    if not b:
        if line:
            text = text.rstrip("\n") + "\n\n[index]\n" + line
    else:
        body = re.sub(r"(?m)^[ \t]*startHeight[ \t]*=.*\n?", "", text[b[0]:b[1]])
        text = text[:b[0]] + line + body + text[b[1]:]
    write_config(text)


def index_files():
    d = network_dir()
    return [os.path.join(d, "db"), os.path.join(d, "recentblocks")]


def index_exists():
    return os.path.exists(os.path.join(network_dir(), "db", "frigate.duckdb"))


def delete_index():
    import shutil
    for path in index_files():
        if os.path.isdir(path):
            shutil.rmtree(path)
        elif os.path.exists(path):
            os.remove(path)
    print("Deleted the index", flush=True)


def admin_port():
    try:
        with open(config_path(), encoding="utf-8") as f:
            m = re.search(r"(?m)^\s*adminPort\s*=\s*(\d+)", f.read())
        return int(m.group(1)) if m else 0
    except OSError:
        return 0


# ---------------------------------------------------------------- frigate

class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.lines = collections.deque(maxlen=LOG_LINES)
        self.phase = "starting"      # starting, waiting-node, indexing, ready, stopped
        self.progress = None         # {"done", "total", "percent", "height"}
        self.compute = None
        self.started_at = time.time()
        self.exit_code = None

    def snapshot(self):
        with self.lock:
            return {
                "phase": self.phase,
                "progress": self.progress,
                "compute": self.compute,
                "startedAt": int(self.started_at),
                "exitCode": self.exit_code,
                "log": list(self.lines),
            }


STATE = State()

RE_WAIT = re.compile(r"Waiting for sync to complete")
RE_INDEXING = re.compile(r"Indexing (\d+) blocks \((\d+) to (\d+)\)")
RE_PROGRESS = re.compile(r"Indexing progress: (\d+) / (\d+) blocks \(([\d.]+)%, height (\d+)\)")
RE_INDEXED = re.compile(r"Indexed \d+ blocks in |Block index is up to date")
RE_LISTENING = re.compile(r"Electrum server listening on")
RE_COMPUTE = re.compile(r"Using (.+?) backend for scanning")


def on_line(line):
    with STATE.lock:
        STATE.lines.append(line)
        if RE_WAIT.search(line):
            STATE.phase = "waiting-node"
        elif m := RE_PROGRESS.search(line):
            done, total = int(m.group(1)), int(m.group(2))
            STATE.phase = "indexing"
            STATE.progress = {"done": done, "total": total, "percent": float(m.group(3)),
                              "height": int(m.group(4))}
        elif m := RE_INDEXING.search(line):
            STATE.phase = "indexing"
            STATE.progress = {"done": 0, "total": int(m.group(1)), "percent": 0.0,
                              "height": int(m.group(2))}
        elif RE_INDEXED.search(line):
            if STATE.progress:
                STATE.progress = {**STATE.progress, "done": STATE.progress["total"], "percent": 100.0}
            if STATE.phase != "ready":
                STATE.phase = "starting"
        elif RE_LISTENING.search(line):
            STATE.phase = "ready"
        if m := RE_COMPUTE.search(line):
            STATE.compute = m.group(1)


def pump(stream):
    for raw in iter(stream.readline, b""):
        line = raw.decode("utf-8", "replace").rstrip("\n")
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
        on_line(line)


class Supervisor:
    """Runs Frigate, and restarts it with a new index when the page asks."""

    NO_REQUEST = object()

    def __init__(self):
        self.lock = threading.Lock()
        self.proc = None
        self.stopping = threading.Event()
        self.rebuild = self.NO_REQUEST   # start height (or None) to rebuild from

    def rebuilding(self):
        with self.lock:
            return self.rebuild is not self.NO_REQUEST

    def request_rebuild(self, height):
        """Stop Frigate; the loop then sets the start height, deletes the
        index and starts Frigate again. False when one is already under way."""
        with self.lock:
            if self.rebuild is not self.NO_REQUEST or self.stopping.is_set():
                return False
            self.rebuild = height
            proc = self.proc
        print(f"Rebuilding the index from {height if height is not None else 'the default'}", flush=True)
        if proc and proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
        return True

    def on_signal(self, _signum, _frame):
        self.stopping.set()
        with self.lock:
            proc = self.proc
        if proc and proc.poll() is None:
            proc.send_signal(signal.SIGTERM)

    def run(self):
        signal.signal(signal.SIGTERM, self.on_signal)
        signal.signal(signal.SIGINT, self.on_signal)
        while True:
            with self.lock:
                self.proc = subprocess.Popen([FRIGATE_BIN, "-d", DATA_DIR, "-n", NETWORK],
                                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                proc = self.proc
                pending = self.rebuild is not self.NO_REQUEST
            if self.stopping.is_set() or pending:
                proc.send_signal(signal.SIGTERM)
            reader = threading.Thread(target=pump, args=(proc.stdout,), daemon=True)
            reader.start()
            rc = proc.wait()
            reader.join(timeout=5)
            print(f"Frigate exited with {rc}", flush=True)
            with self.lock:
                height, self.rebuild = self.rebuild, self.NO_REQUEST
            if self.stopping.is_set():
                with STATE.lock:
                    STATE.phase, STATE.exit_code = "stopped", rc
                return 0
            if height is self.NO_REQUEST:
                with STATE.lock:
                    STATE.phase, STATE.exit_code = "stopped", rc
                return rc or 1
            set_start_height(height)
            delete_index()
            with STATE.lock:
                STATE.phase, STATE.progress, STATE.exit_code = "starting", None, None
                STATE.started_at = time.time()


SUPERVISOR = Supervisor()


# ---------------------------------------------------------------- status

def getinfo():
    port = admin_port()
    if not port:
        return None, "config.toml で adminPort が設定されていません"
    req = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getinfo", "params": []}) + "\n"
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=3) as s:
            s.settimeout(3)
            s.sendall(req.encode())
            buf = b""
            while not buf.endswith(b"\n") and len(buf) < 256 * 1024:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
        res = json.loads(buf)
    except (OSError, ValueError):
        return None, None
    if "error" in res:
        return None, str(res["error"].get("message", res["error"]))
    return res.get("result"), None


def status():
    snap = STATE.snapshot()
    info, info_error = (None, None)
    if SUPERVISOR.rebuilding():
        snap["phase"] = "rebuilding"
    elif snap["phase"] != "stopped":
        info, info_error = getinfo()
        if info and snap["phase"] != "ready":
            snap["phase"] = "ready"
    configured = start_height()
    return {
        "startHeight": configured,
        "defaultStartHeight": DEFAULT_START_HEIGHT,
        "effectiveStartHeight": DEFAULT_START_HEIGHT if configured is None else configured,
        "indexExists": index_exists(),
        **snap,
        "version": VERSION,
        "network": NETWORK,
        "networkLabel": NETWORK_LABELS.get(NETWORK, NETWORK),
        "electrumPort": ELECTRUM_PORT,
        "host": os.environ.get("DEVICE_DOMAIN_NAME", ""),
        "info": info,
        "infoError": info_error,
    }


STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
}


class Handler(BaseHTTPRequestHandler):
    server_version = "frigate-umbrel"

    def log_message(self, fmt, *args):
        pass

    def send_body(self, code, body, ctype, cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/status":
            return self.send_body(200, json.dumps(status()).encode(), "application/json")
        if path in STATIC:
            name, ctype = STATIC[path]
            try:
                with open(os.path.join(WEB_DIR, name), "rb") as f:
                    body = f.read()
            except OSError:
                return self.send_body(404, b"not found", "text/plain")
            return self.send_body(200, body, ctype, "no-cache")
        self.send_body(404, b"not found", "text/plain")

    def send_json(self, code, obj):
        self.send_body(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json")

    def read_json_body(self):
        # A JSON content type makes cross-site form posts impossible
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            return None
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length > 10000:
            return None
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        data = self.read_json_body()
        if data is None:
            return self.send_json(400, {"error": "リクエストが正しくありません"})
        if path == "/api/start-height":
            height = data.get("startHeight")
            if height is not None:
                if type(height) is not int or not 0 <= height <= MAX_START_HEIGHT:
                    return self.send_json(400, {"error": f"ブロック高は 0〜{MAX_START_HEIGHT:,} の整数で指定してください"})
                if height == DEFAULT_START_HEIGHT:
                    height = None
            if height == start_height() and data.get("rebuild") is not True:
                return self.send_json(200, {"ok": True, "changed": False})
            if not SUPERVISOR.request_rebuild(height):
                return self.send_json(409, {"error": "作り直しの最中です。終わってからもう一度試してください"})
            return self.send_json(200, {"ok": True, "changed": True})
        self.send_json(404, {"error": "not found"})


def run_web():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"Status page on :{PORT}", flush=True)
    server.serve_forever()


def main():
    prepare_config()
    threading.Thread(target=run_web, daemon=True).start()
    return SUPERVISOR.run()


if __name__ == "__main__":
    sys.exit(main())
