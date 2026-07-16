#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-PERF §0 step 2 — the probe that gates steps 4-8: can a `--html` kernel OWN THE LOOP
# (gather commands via host_input(), frame_yield() between them) and KEEP STATE across commands?
# If this fails, the session steps (hold stores / Graph / MatchState across clicks) are fiction.
#   tools/loop_probe.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
loft="${LOFT_BIN:-loft}"
dtport="${DTPORT:-9257}"; httpport="${HTTPPORT:-8161}"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v python3 >/dev/null || { echo "SKIP: python3 not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }

tmp="$(mktemp -d)"; trap 'kill ${chr:-} ${srv:-} 2>/dev/null; rm -rf "$tmp"' EXIT
"$loft" --html "$tmp/probe.html" --lib "$here/lib" "$here/browser/loop_probe.loft" || exit 1

echo "== loop probe: can a --html kernel own the loop and keep state? =="
python3 -m http.server "$httpport" --directory "$tmp" >/dev/null 2>&1 & srv=$!
"$chromium" --headless=new --disable-gpu --no-sandbox --window-size=800,600 \
  --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port="$dtport" about:blank >/dev/null 2>&1 & chr=$!
sleep 4
node "$here/browser/cdp_loop_probe.mjs" "127.0.0.1:$dtport" "http://127.0.0.1:$httpport/probe.html"
