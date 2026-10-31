"""Blocktime server.

Serves the static UI, keeps which mempool to use in SETTINGS_FILE, and relays
/mempool-api/<path> to <mempool>/api/<path> so the browser needs no CORS.
Standard library only.
"""

import json
import os
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "80"))
WEB_DIR = os.environ.get("WEB_DIR", "/web")
SETTINGS_FILE = os.environ.get("SETTINGS_FILE", "/data/settings.json")
# Umbrel's own Mempool app (its web container serves /api without login)
UMBREL_MEMPOOL_URL = os.environ.get("UMBREL_MEMPOOL_URL", "http://10.21.21.26:3006")
UMBREL_MEMPOOL_PORT = os.environ.get("UMBREL_MEMPOOL_PORT", "3006")

SOURCES = {
    "umbrel": "Umbrel の Mempool",
    "mempool.space": "mempool.space",
    "custom": "任意の URL",
}
DEFAULTS = {"source": "umbrel", "customUrl": ""}
API_PATH_RE = re.compile(r"^[A-Za-z0-9/_.:-]{1,200}$")
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}


def load_settings():
    settings = dict(DEFAULTS)
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            saved = json.load(f)
        if isinstance(saved, dict):
            settings.update({k: saved[k] for k in DEFAULTS if k in saved})
    except (OSError, ValueError):
        pass
    if settings["source"] not in SOURCES:
        settings["source"] = "umbrel"
    return settings


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


def normalize_url(raw):
    url = str(raw or "").strip().rstrip("/")
    if url.endswith("/api"):
        url = url[: -len("/api")]
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        return None
    return url


def validate(data):
    errors = {}
    source = str(data.get("source", ""))
    if source not in SOURCES:
        errors["source"] = "接続先を選んでください"
    custom = str(data.get("customUrl", "")).strip()
    if source == "custom":
        normalized = normalize_url(custom)
        if not normalized:
            errors["customUrl"] = "http:// か https:// で始まる URL を入れてください（例: http://192.168.1.20:3006）"
        else:
            custom = normalized
    return {"source": source, "customUrl": custom}, errors


def base_url(settings):
    if settings["source"] == "mempool.space":
        return "https://mempool.space"
    if settings["source"] == "custom" and settings["customUrl"]:
        return settings["customUrl"]
    return UMBREL_MEMPOOL_URL


def public_config(settings):
    """What the browser needs: a label and where block links should open."""
    if settings["source"] == "umbrel":
        # The internal address is not reachable from the browser; the app port on
        # the Umbrel host is. The page fills in its own hostname.
        explorer = {"sameHostPort": UMBREL_MEMPOOL_PORT}
    else:
        explorer = {"url": base_url(settings)}
    return {
        "source": settings["source"],
        "customUrl": settings["customUrl"],
        "label": SOURCES[settings["source"]] if settings["source"] != "custom" else base_url(settings),
        "explorer": explorer,
    }


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "Blocktime", "Accept": "application/json, text/plain"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.headers.get("Content-Type", "text/plain"), resp.read()


class Handler(BaseHTTPRequestHandler):
    server_version = "Blocktime"

    def log_message(self, fmt, *args):
        pass

    def send_body(self, code, body, content_type, cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, code, payload):
        self.send_body(code, json.dumps(payload).encode(), "application/json")

    def read_json(self):
        # Only accept JSON with a custom header, so a plain cross-site form cannot post here.
        if self.headers.get("X-Requested-With") != "blocktime":
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
        path = urllib.parse.urlparse(self.path).path
        if path == "/healthz":
            self.send_body(200, b"ok\n", "text/plain")
        elif path == "/config":
            self.send_json(200, public_config(load_settings()))
        elif path.startswith("/mempool-api/"):
            self.relay(path[len("/mempool-api/"):])
        else:
            self.static(path)

    def relay(self, api_path):
        if not API_PATH_RE.match(api_path) or ".." in api_path:
            self.send_json(400, {"error": "bad path"})
            return
        try:
            status, content_type, body = fetch(f"{base_url(load_settings())}/api/{api_path}")
            self.send_body(status, body, content_type)
        except urllib.error.HTTPError as e:
            self.send_body(e.code, e.read(), e.headers.get("Content-Type", "text/plain"))
        except (urllib.error.URLError, OSError) as e:
            self.send_json(502, {"error": f"mempool に接続できません: {getattr(e, 'reason', e)}"})

    def static(self, path):
        name = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.realpath(os.path.join(WEB_DIR, name))
        if not full.startswith(os.path.realpath(WEB_DIR) + os.sep) or not os.path.isfile(full):
            full = os.path.join(WEB_DIR, "index.html")
        ext = os.path.splitext(full)[1]
        with open(full, "rb") as f:
            self.send_body(200, f.read(), STATIC_TYPES.get(ext, "application/octet-stream"), cache="no-cache")

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        data = self.read_json()
        if data is None:
            self.send_json(400, {"error": "bad request"})
            return
        settings, errors = validate(data)
        if errors:
            self.send_json(400, {"errors": errors})
            return
        if path == "/config":
            try:
                save_settings(settings)
            except OSError as e:
                self.send_json(500, {"error": f"保存できません: {e}"})
                return
            self.send_json(200, public_config(settings))
        elif path == "/config/test":
            url = base_url(settings)
            try:
                _, _, body = fetch(f"{url}/api/blocks/tip/height", timeout=10)
                height = int(body.decode().strip())
                self.send_json(200, {"ok": True, "height": height, "url": url})
            except urllib.error.HTTPError as e:
                self.send_json(200, {"ok": False, "error": f"HTTP {e.code}（mempool の URL か確認してください）", "url": url})
            except ValueError:
                self.send_json(200, {"ok": False, "error": "mempool の API ではないようです", "url": url})
            except (urllib.error.URLError, OSError) as e:
                self.send_json(200, {"ok": False, "error": f"接続できません: {getattr(e, 'reason', e)}", "url": url})
        else:
            self.send_json(404, {"error": "not found"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
