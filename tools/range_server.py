#!/usr/bin/env python3
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# A static server that actually honours `Range: bytes=a-b` (206 + Content-Range), which
# `python -m http.server` does NOT. PLAN-SCALE's whole read path is byte-range reads of a hosted store,
# so the harness has to serve them or a probe proves nothing about the real thing.
#
# Also: GET /report?r=... appends r to a report file — the channel a headless browser reports through.
#
#   python3 tools/range_server.py [port] [root] [report-file]
import http.server, socketserver, sys, os, re, urllib.parse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
ROOT = sys.argv[2] if len(sys.argv) > 2 else "."
REPORT = sys.argv[3] if len(sys.argv) > 3 else os.path.join(ROOT, ".range-report")
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        if path.endswith(".wasm"):
            return "application/wasm"
        if path.endswith((".js", ".mjs")):
            return "text/javascript"
        if path.endswith(".store"):
            return "application/octet-stream"
        return super().guess_type(path)

    def do_GET(self):
        if self.path.startswith("/report"):
            q = urllib.parse.urlparse(self.path).query
            with open(REPORT, "a") as f:
                f.write(urllib.parse.parse_qs(q).get("r", [""])[0] + "\n")
            self.send_response(204)
            self.end_headers()
            return
        rng = self.headers.get("Range")
        if not rng:
            return super().do_GET()
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().do_GET()
        size = os.path.getsize(path)
        m = RANGE_RE.match(rng.strip())
        if not m:
            self.send_error(400, "bad Range")
            return
        lo_s, hi_s = m.group(1), m.group(2)
        if lo_s == "":                                  # suffix form: bytes=-N
            length = min(int(hi_s or 0), size)
            lo, hi = size - length, size - 1
        else:
            lo = int(lo_s)
            hi = int(hi_s) if hi_s else size - 1
        if lo >= size or lo > hi:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return
        hi = min(hi, size - 1)
        length = hi - lo + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {lo}-{hi}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(lo)
            self.wfile.write(f.read(length))

    def log_message(self, *a):
        if os.environ.get("RANGE_LOG"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), a[0] % a[1:]))


socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H) as httpd:
    print(f"range server: {ROOT} on http://127.0.0.1:{PORT}", flush=True)
    httpd.serve_forever()
