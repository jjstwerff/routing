#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Phase profile of the standalone store app in headless Chromium — the measurement PLAN-PERF rests on.
# Attributes the cost of `view` / `match` to wasm-side (store decode + text serialize) vs JS-side
# (text parse) vs render, so the design targets the real bottleneck instead of the assumed one.
#   tools/map_profile.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
profile="$here/scratch/chromium-map_profile"
httpport="${HTTPPORT:-8149}"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v python3 >/dev/null || { echo "SKIP: python3 not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }

node "$here/browser/build-site.mjs" || exit 1
[ -f "$here/browser/store-kernel.wasm" ] || { echo "SKIP: browser/store-kernel.wasm missing (run: node browser/build-store-kernel.mjs)"; exit 2; }

rm -rf "$profile"; mkdir -p "$here/scratch"
srv=""
cleanup() { [ -n "$srv" ] && kill "$srv" 2>/dev/null; return 0; }
trap cleanup EXIT
python3 -m http.server "$httpport" --directory "$here/_site" >/dev/null 2>&1 &
srv=$!
# ⚠ THIS SCRIPT NO LONGER LAUNCHES A BROWSER, and that is the point. It used to start Chromium on a
# debugging PORT and take it down from `trap cleanup EXIT` — correct for every way this script ends, and
# useless for the way it actually dies (a timeout or an interrupted turn kills the shell, no trap runs,
# and a detached browser owned by nobody runs for days). The driver now owns it over a CDP pipe, so the
# browser cannot outlive `node` on any OS and there is nothing here to clean up. See browser/cdp_transport.mjs.
echo "== store-app phase profile =="
CHROMIUM_BIN="$chromium" node "$here/browser/cdp_profile.mjs" "$profile" "http://127.0.0.1:$httpport/index.html" "${CPU_THROTTLE:-1}"
rc=$?
exit $rc
