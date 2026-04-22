#!/usr/bin/env python3
"""
Simple genealogy server.
Stores each person as data/<technical_id>/data.json with a "versions" array.
Photos are stored as data/<technical_id>/photo_v<N>.<ext>.
"""
import json
import os
import sys
import base64
import datetime
import mimetypes
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
INDEX_FILE = os.path.join(BASE_DIR, "index.html")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
DEFAULT_SETTINGS = {"site_name": "מאגר אנשים"}
os.makedirs(DATA_DIR, exist_ok=True)


def load_settings():
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            if not isinstance(data, dict):
                return dict(DEFAULT_SETTINGS)
            merged = dict(DEFAULT_SETTINGS)
            merged.update(data)
            return merged
    except FileNotFoundError:
        return dict(DEFAULT_SETTINGS)
    except (OSError, json.JSONDecodeError):
        return dict(DEFAULT_SETTINGS)


def save_settings(data):
    merged = dict(DEFAULT_SETTINGS)
    merged.update(data or {})
    # Only keep known keys to avoid writing arbitrary fields.
    out = {k: merged[k] for k in DEFAULT_SETTINGS if k in merged}
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    os.replace(tmp, SETTINGS_FILE)
    return out

ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


def person_dir(tid):
    if not ID_RE.match(tid):
        raise ValueError("invalid technical id")
    return os.path.join(DATA_DIR, tid)


def load_person(tid):
    p = os.path.join(person_dir(tid), "data.json")
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, ValueError) as e:
        sys.stderr.write(f"[WARN] Skipping corrupt data.json for {tid}: {e}\n")
        return None


def save_person(tid, obj):
    d = person_dir(tid)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "data.json")
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


def list_people():
    result = []
    if not os.path.isdir(DATA_DIR):
        return result
    for name in sorted(os.listdir(DATA_DIR)):
        d = os.path.join(DATA_DIR, name)
        if not os.path.isdir(d):
            continue
        obj = load_person(name)
        if not obj:
            continue
        latest = obj["versions"][-1] if obj.get("versions") else {}
        data = latest.get("data", {})
        # derive display name
        display_he = ""
        display_en = ""
        for key in ("first_name", "hebrew_name", "last_name"):
            fld = data.get(key) or {}
            if fld.get("he"):
                display_he = (display_he + " " + fld["he"]).strip()
            if fld.get("en"):
                display_en = (display_en + " " + fld["en"]).strip()
        last = data.get("last_name") or {}
        if last.get("he") and last.get("he") not in display_he:
            display_he = (display_he + " " + last["he"]).strip()
        if last.get("en") and last.get("en") not in display_en:
            display_en = (display_en + " " + last["en"]).strip()
        result.append({
            "technical_id": name,
            "display_he": display_he,
            "display_en": display_en,
            "version_count": len(obj.get("versions", [])),
            "last_saved": latest.get("saved_at"),
        })
    return result


_SAFE_EXT_RE = re.compile(r"^[A-Za-z0-9]{1,10}$")

def process_photos(tid, data, version):
    """Materialize `data_url` items in `files` (or legacy `photos`) into real
    files on disk under person_dir(tid). Accepts any MIME type. Items with an
    existing `file` reference are carried over unchanged.

    Returned data has a normalized `files` list and no `photos`/`photo`/`data_url`
    keys anywhere. GUARANTEE: never contains data_url strings.
    """
    # Accept either "files" (new) or "photos" (legacy); combine if both exist.
    items_in = []
    if isinstance(data.get("files"), list):
        items_in.extend(data["files"])
    if isinstance(data.get("photos"), list):
        items_in.extend(data["photos"])
    files_out = []
    idx = 0
    for item in items_in:
        if not isinstance(item, dict):
            continue
        comment = item.get("comment", "") or ""
        if item.get("data_url"):
            # Accept any MIME type, not just image/*
            m2 = re.match(r"^data:([A-Za-z0-9.+\-]+/[A-Za-z0-9.+\-]+);base64,(.+)$",
                          item["data_url"], re.DOTALL)
            if m2:
                mime, b64 = m2.group(1), m2.group(2)
                # Prefer the extension from the original filename if given
                ext = ""
                orig_name = item.get("name") or ""
                if orig_name:
                    root, e = os.path.splitext(orig_name)
                    if e and _SAFE_EXT_RE.match(e[1:]):
                        ext = e.lower()
                if not ext:
                    guessed = mimetypes.guess_extension(mime) or ".bin"
                    if guessed == ".jpe":
                        guessed = ".jpg"
                    ext = guessed
                fname = f"file_v{version}_{idx}{ext}"
                with open(os.path.join(person_dir(tid), fname), "wb") as f:
                    f.write(base64.b64decode(b64))
                files_out.append({"file": fname, "comment": comment})
                idx += 1
            else:
                sys.stderr.write(f"[WARN] Skipping file with unrecognised data_url "
                                 f"(head: {item['data_url'][:60]})\n")
        elif item.get("file"):
            files_out.append({"file": item["file"], "comment": comment})
            idx += 1
    data["files"] = files_out
    # Remove legacy fields from saved JSON
    data.pop("photos", None)
    data.pop("photo", None)

    # Belt-and-suspenders: walk the entire data tree and strip any remaining
    # data_url / name / mime ephemerals so upload metadata isn't persisted.
    _strip_data_urls(data)
    return data


def _strip_data_urls(obj):
    """Recursively remove any 'data_url' keys from dicts."""
    if isinstance(obj, dict):
        obj.pop("data_url", None)
        for v in obj.values():
            _strip_data_urls(v)
    elif isinstance(obj, list):
        for v in obj:
            _strip_data_urls(v)


def _is_empty(v):
    """Treat 'no useful content' values as empty so they can be pruned."""
    if v is None:
        return True
    if isinstance(v, bool):
        return v is False
    if isinstance(v, (int, float)):
        return False  # explicit numbers count as content
    if isinstance(v, str):
        return v == ""
    if isinstance(v, list):
        return all(_is_empty(x) for x in v)
    if isinstance(v, dict):
        # ref-like field — only inspect the relevant subset
        if "mode" in v:
            if v.get("mode") == "link":
                relevant = {"link_id": v.get("link_id", ""), "comment": v.get("comment", "")}
            else:
                relevant = {"he": v.get("he", ""), "en": v.get("en", ""), "comment": v.get("comment", "")}
        else:
            relevant = {k: val for k, val in v.items() if k not in ("year_only",)}
        if not relevant:
            return True
        return all(_is_empty(x) for x in relevant.values())
    return False


def prune_empty(data):
    """Recursively remove keys whose values are 'empty' according to _is_empty."""
    if isinstance(data, dict):
        out = {}
        for k, v in data.items():
            pv = prune_empty(v)
            if _is_empty(pv):
                continue
            out[k] = pv
        return out
    if isinstance(data, list):
        out = []
        for x in data:
            px = prune_empty(x)
            if not _is_empty(px):
                out.append(px)
        return out
    return data


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ---- helpers ----
    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, content_type=None):
        if not os.path.exists(path):
            self.send_error(404)
            return
        if content_type is None:
            content_type, _ = mimetypes.guess_type(path)
            content_type = content_type or "application/octet-stream"
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    # ---- routing ----
    def do_GET(self):
        u = urlparse(self.path)
        path = unquote(u.path)
        if path == "/" or path == "/index.html":
            self._send_file(INDEX_FILE, "text/html; charset=utf-8")
            return
        if path == "/styles.css":
            self._send_file(os.path.join(BASE_DIR, "styles.css"), "text/css; charset=utf-8")
            return
        if path == "/app.js":
            self._send_file(os.path.join(BASE_DIR, "app.js"), "application/javascript; charset=utf-8")
            return
        if path == "/api/people":
            self._send_json(200, list_people())
            return
        if path == "/api/settings":
            self._send_json(200, load_settings())
            return
        if path == "/api/people/all":
            # Return every person's full JSON (all versions) for client-side search.
            all_data = []
            if os.path.isdir(DATA_DIR):
                for name in sorted(os.listdir(DATA_DIR)):
                    d = os.path.join(DATA_DIR, name)
                    if not os.path.isdir(d):
                        continue
                    obj = load_person(name)
                    if obj:
                        all_data.append(obj)
            self._send_json(200, all_data)
            return
        m = re.match(r"^/api/people/([A-Za-z0-9_\-]+)$", path)
        if m:
            obj = load_person(m.group(1))
            if obj is None:
                self._send_json(404, {"error": "not found"})
                return
            self._send_json(200, obj)
            return
        m = re.match(r"^/(?:files|photos)/([A-Za-z0-9_\-]+)/((?:file|photo)_v\d+(?:_\d+)?\.[A-Za-z0-9]+)$", path)
        if m:
            tid, fname = m.group(1), m.group(2)
            self._send_file(os.path.join(person_dir(tid), fname))
            return
        self.send_error(404)

    def do_POST(self):
        u = urlparse(self.path)
        path = unquote(u.path)
        try:
            if path == "/api/people":
                body = self._read_json()
                tid = body.get("technical_id", "").strip()
                if not ID_RE.match(tid):
                    self._send_json(400, {"error": "invalid technical_id (use letters, digits, _, -)"})
                    return
                if load_person(tid) is not None:
                    self._send_json(409, {"error": "already exists"})
                    return
                # Ensure the person directory exists so photo files can be written
                os.makedirs(person_dir(tid), exist_ok=True)
                data = body.get("data") or {}
                data = process_photos(tid, data, version=1)
                data = prune_empty(data)
                now = datetime.datetime.now().isoformat(timespec="seconds")
                obj = {
                    "technical_id": tid,
                    "versions": [{"version": 1, "saved_at": now, "data": data}],
                }
                save_person(tid, obj)
                self._send_json(200, obj)
                return

            if path == "/api/settings":
                body = self._read_json()
                out = save_settings(body)
                self._send_json(200, out)
                return

            m = re.match(r"^/api/people/([A-Za-z0-9_\-]+)/save$", path)
            if m:
                tid = m.group(1)
                body = self._read_json()
                data = body.get("data") or {}
                obj = load_person(tid)
                if obj is None:
                    self._send_json(404, {"error": "not found"})
                    return
                new_version = (obj["versions"][-1]["version"] if obj["versions"] else 0) + 1
                data = process_photos(tid, data, version=new_version)
                data = prune_empty(data)
                now = datetime.datetime.now().isoformat(timespec="seconds")
                obj["versions"].append({
                    "version": new_version,
                    "saved_at": now,
                    "data": data,
                })
                save_person(tid, obj)
                self._send_json(200, obj)
                return

            self.send_error(404)
        except Exception as e:
            self._send_json(500, {"error": str(e)})


def main():
    host = "127.0.0.1"
    port = int(os.environ.get("PORT", "80"))
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"Serving at http://{host}:{port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
