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
import http.server, socketserver, sys, os, re, time, urllib.parse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
ROOT = sys.argv[2] if len(sys.argv) > 2 else "."
RANGE_LOG = os.environ.get("RANGE_LOG", "")
# LATENCY_MS injects a fixed per-request delay. A local server has ~0 RTT, which is exactly the variable
# that dominates a real paged read (measured against GitHub Pages: 26 ms TTFB on a reused connection, and
# a 64 kB range costs the same as one byte). Without this an A/B of prefetching measures nothing, because
# the thing prefetching removes is not present. Set it to the RTT you are modelling.
LATENCY_MS = float(os.environ.get("LATENCY_MS", "0"))
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

    def do_OPTIONS(self):
        # The preflight. A `Range` request header is NOT CORS-safelisted, so a cross-origin paged read
        # begins with OPTIONS — and a host that answers only GET looks exactly like a host with no CORS:
        # the browser blocks the read and the app renders nothing. Any real bucket policy must allow the
        # Range REQUEST header here, not just expose Content-Range on the response.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/report"):
            q = urllib.parse.urlparse(self.path).query
            with open(REPORT, "a") as f:
                f.write(urllib.parse.parse_qs(q).get("r", [""])[0] + "\n")
            self.send_response(204)
            self.end_headers()
            return
        if LATENCY_MS: time.sleep(LATENCY_MS / 1000.0)
        rng = self.headers.get("Range")
        # RANGE_LOG=<file> records what the client ASKED FOR — the only honest way to build a page index
        # (tools/build_page_index.sh). `LOFT_LOADER_STATS=1` reports a histogram and no offsets, and a
        # second purpose-built server got this WRONG: omitting `Accept-Ranges` above made the loader probe
        # with a plain GET and then read differently, so the recorded pages were an artefact of the
        # instrument. Logging from the server that already serves every gate cannot drift like that.
        if RANGE_LOG:
            with open(RANGE_LOG, "a") as lf:
                lf.write(("R " + rng.strip() if rng else "WHOLE") + " " + self.path + "\n")
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
