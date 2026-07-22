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
dtport="${DTPORT:-9248}"
httpport="${HTTPPORT:-8152}"
loft="${LOFT_BIN:-$(command -v loft)}"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v python3 >/dev/null || { echo "SKIP: python3 not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
[ -x "$loft" ] || { echo "SKIP: loft not found"; exit 2; }

node "$here/browser/build-site.mjs" || exit 1
store="$here/_site/stores/enschede.layout.store"
[ -f "$store" ] || { echo "SKIP: $store missing"; exit 2; }

rm -rf "$here/scratch/chromium-$dtport"; mkdir -p "$here/scratch"
srv=""; chr=""
cleanup() { kill "$chr" "$srv" 2>/dev/null; }
trap cleanup EXIT
python3 -m http.server "$httpport" --directory "$here/_site" >/dev/null 2>&1 &
srv=$!
"$chromium" --headless=new --disable-gpu --no-sandbox --window-size=1000,700 \
  --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port="$dtport" about:blank >/dev/null 2>&1 &
chr=$!
sleep 4

echo "== step 10: does JS read the same tile loft reads? =="
js="$(node "$here/browser/cdp_deliver.mjs" "127.0.0.1:$dtport" "http://127.0.0.1:$httpport/index.html")"
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
