#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-PERF §0 step 10's gate: JS reads a tile straight out of the exposed layout store (via loft's own
# descriptor reader) and it must equal what LOFT reads for that same tile.
#
# The comparison is the point. Step 9 only proved a descriptor arrived; a reader that misreads a field
# offset or a type id still returns plausible numbers rather than an error, so the only honest check is
# against loft's own read of the same record — `tools/tile_lookup.loft`, which prints the identical
# TILE line format from the loft side.
#
#   tools/deliver_probe.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
profile="$here/scratch/chromium-deliver"
httpport="${HTTPPORT:-8152}"
loft="${LOFT_BIN:-$(command -v loft)}"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v python3 >/dev/null || { echo "SKIP: python3 not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
[ -x "$loft" ] || { echo "SKIP: loft not found"; exit 2; }

SITE_LOCAL_ONLY=1 node "$here/browser/build-site.mjs" || exit 1
store="$here/_site/stores/enschede.layout.store"
[ -f "$store" ] || { echo "SKIP: $store missing"; exit 2; }

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
echo "== steps 10-11: the @PLN105 bridge — JS reads tiles + areas from the exposed store =="
js="$(CHROMIUM_BIN="$chromium" node "$here/browser/cdp_deliver.mjs" "$profile" "http://127.0.0.1:$httpport/index.html")"
rc=$?
echo "$js" | grep -v '^JSTILE'
[ $rc -eq 0 ] || { echo "$js" | grep '^FAIL' ; exit 1; }

jsline="$(echo "$js" | grep '^JSTILE' | sed 's/^JSTILE //')"
[ -n "$jsline" ] || { echo "FAIL: no JSTILE line from the browser"; exit 1; }
tkey="$(echo "$jsline" | sed -n 's/.*tkey=\([0-9-]*\).*/\1/p')"

loftline="$("$loft" --native --lib "$here/lib" "$here/tools/tile_lookup.loft" "$store" "$tkey" 2>/dev/null | grep '^TILE ' | sed 's/^TILE //')"
[ -n "$loftline" ] || { echo "FAIL: loft did not return a TILE line for tkey=$tkey"; exit 1; }

echo "  js  : $jsline"
echo "  loft: $loftline"
if [ "$jsline" = "$loftline" ]; then
  echo "PASS — JS read the tile byte-for-byte as loft reads it (scalars, 5 collection counts, nested ring)"
  exit 0
fi
echo "FAIL — JS and loft disagree on tkey=$tkey"
exit 1
