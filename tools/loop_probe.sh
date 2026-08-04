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
profile="$here/scratch/chromium-loop"
httpport="${HTTPPORT:-8161}"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v python3 >/dev/null || { echo "SKIP: python3 not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }

tmp="$(mktemp -d)"; trap 'kill ${srv:-} 2>/dev/null; rm -rf "$tmp"' EXIT
"$loft" --html "$tmp/probe.html" --lib "$here/lib" "$here/browser/loop_probe.loft" || exit 1

echo "== loop probe: can a --html kernel own the loop and keep state? =="
rm -rf "$profile"; mkdir -p "$here/scratch"   # hermetic: no localStorage carried in from the last run
python3 -m http.server "$httpport" --directory "$tmp" >/dev/null 2>&1 & srv=$!
# ⚠ THIS SCRIPT NO LONGER LAUNCHES A BROWSER, and that is the point. It used to start Chromium on a
# debugging PORT and take it down from `trap cleanup EXIT` — correct for every way this script ends, and
# useless for the way it actually dies (a timeout or an interrupted turn kills the shell, no trap runs,
# and a detached browser owned by nobody runs for days). The driver now owns it over a CDP pipe, so the
# browser cannot outlive `node` on any OS and there is nothing here to clean up. See browser/cdp_transport.mjs.
CHROMIUM_BIN="$chromium" node "$here/browser/cdp_loop_probe.mjs" "$profile" "http://127.0.0.1:$httpport/probe.html"
