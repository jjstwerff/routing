#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-SCALE D2 — the acceptance test for a CORS host: the app on one origin, its blocks on ANOTHER,
# read by byte range.
#
# WHY IT EXISTS. Neither GitHub surface can do this, measured 2026-07-30:
#
#   release asset   Range ✅ (206 + Content-Range)   CORS ❌ (no ACAO, even with an Origin header)
#   GitHub Pages    Range ✅ (real 206 + Content-Range)                       CORS n/a (same origin, sends ACAO:*)
#
# ⚠ That Pages row READ "Range ❌" until 2026-07-30 and was wrong: the measurement behind it was taken
# against `python3 -m http.server`, which ignores Range and returns the whole file. Pages itself is fine.
# This gate is still the acceptance test for a THIRD-PARTY host; it is no longer evidence that one is
# needed.
#
# So the browser has only ever read blocks that ship beside it, and "a CORS host would work" was an
# assumption. This makes it a test: any candidate host (R2, B2, a bucket behind a CDN) either passes it or
# is not a host for this app. Here it runs against `tools/range_server.py`, which sends the two headers a
# real one must send — `Access-Control-Allow-Origin` and `Access-Control-Expose-Headers: Content-Range`.
#
# The two failure modes it separates, because they look identical from a screenshot:
#   * no CORS  → the fetch is blocked, the store never loads, the app renders nothing;
#   * no Range → everything renders, having downloaded the whole block per read. It is only visible as
#     `rangeReads == 0`, which is why the gate asserts the reads and not just the pixels.
#
#   tools/cors_host_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
dtport="${DTPORT:-9243}"
appport="${APPPORT:-8143}"     # the app's origin
dataport="${DATAPORT:-8144}"   # a DIFFERENT origin for the blocks — same host, different port, which is
                               # a distinct origin to the browser and enough to require CORS
site="$here/_site"
work="$(mktemp -d)"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
[ -f "$site/stores/enschede.roads.store" ] || { echo "SKIP: no built site (run tools/map_render_gate.sh first)"; exit 2; }

app=""; data=""; chr=""
cleanup() { kill "$chr" "$app" "$data" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT

echo "== D2: the app on one origin, its blocks on another =="
# A manifest holding ONLY the region under test, published at the DATA origin.
#
# ⚠ It must hold only that one, and that is not tidiness. The first version copied the whole manifest and
# built it with RELEASE_INDEX=1, so the index named the local CORS host AND the GitHub-hosted Netherlands
# regions. A match whose padded box escapes the small block then names BOTH — and the read of the
# release-hosted one fails ("Failed to fetch — bytes 0-0 of nl-east.roads.store", a size probe the browser
# refuses for want of CORS), which takes the whole working set down with it: ways=0, an empty route, on a
# host that was working perfectly.
#
# So: AN INDEX MUST NOT MIX REACHABLE AND UNREACHABLE HOSTS. One unreachable block in a covering set does
# not degrade the match, it ends it. That is the same rule as "each index names only what it can serve",
# and this is what violating it looks like from the inside.
# The FIXTURE manifest, whose one region is the Enschede block this gate republishes at a second origin
# (the symlink below already assumes it). `data/coverage.toml`'s first region is the overview now, which
# has no roads at all — taking it left the index naming a block the driver could not resolve.
awk -v ub="http://127.0.0.1:$dataport/stores" '
  /^\[\[region\]\]/ { if (keep) exit; n++ }
  n == 1 { if ($0 ~ /^read_mode/) print "read_mode = \"paged\"\nurl_base  = \"" ub "\""; else print }
' "$here/data/coverage-fixture.toml" > "$work/coverage.toml"
# PUBLISH_ROOT — this gate publishes to a local ORIGIN, not to `blocks/`, and `build_index.sh` decides
# "is this region being published" by looking there. Point it at the stores this gate actually serves, or
# the region is judged site-local, the release index comes out empty and the build fails.
mkdir -p "$work/published"
for s in "$site"/stores/enschede.*; do ln -sf "$s" "$work/published/"; done
COVERAGE_MANIFEST="$work/coverage.toml" RELEASE_INDEX=1 PUBLISH_ROOT="$work/published" \
  "$here/tools/build_index.sh" "$site/coverage.json" \
  >/dev/null || { echo "  FAIL: could not build the cross-origin index"; exit 1; }
grep -c '^\[\[region\]\]' "$work/coverage.toml" | grep -qx 1 || { echo "  FAIL: the test manifest holds more than one region"; exit 1; }
grep -q "127.0.0.1:$dataport" "$site/coverage.json" || { echo "  FAIL: the index does not name the data origin"; exit 1; }
echo "  index → http://127.0.0.1:$dataport/stores"

python3 -m http.server "$appport" --directory "$site" >/dev/null 2>&1 &
app=$!
# The data origin MUST serve Range and CORS; range_server.py does both. `python -m http.server` on the app
# side is fine — the page itself is not range-read.
RANGE_LOG=1 python3 "$here/tools/range_server.py" "$dataport" "$site" /dev/null >"$work/data.log" 2>&1 &
data=$!
sleep 1
code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: http://127.0.0.1:'"$appport" -H 'Range: bytes=0-99' \
        "http://127.0.0.1:$dataport/stores/enschede.roads.store")"
acao="$(curl -sI -H 'Origin: http://127.0.0.1:'"$appport" "http://127.0.0.1:$dataport/stores/enschede.roads.store" | grep -ci 'access-control-allow-origin' || true)"
echo "  data origin: HTTP $code, ACAO header present: $acao"
[ "$code" = "206" ] && [ "$acao" -ge 1 ] || { echo "  FAIL: the data origin is not a CORS+Range host"; exit 1; }

rm -rf "$here/scratch/chromium-$dtport"; mkdir -p "$here/scratch"
"$chromium" --headless=new --disable-gpu --no-sandbox --window-size=1000,700 \
  --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port="$dtport" about:blank >/dev/null 2>&1 &
chr=$!
sleep 4

node "$here/browser/cdp_cors_host.mjs" "127.0.0.1:$dtport" \
  "http://127.0.0.1:$appport/index.html" "http://127.0.0.1:$dataport"
rc=$?
[ $rc -eq 0 ] || { echo "  --- data-origin requests that did not return 2xx ---"; grep -vE " (200|204|206) " "$work/data.log" | tail -5 | sed "s/^/  /"; }

# Leave the site index as the tree describes it, not as this gate rewrote it.
#
# ⚠ INTO `$site`, which is where the damage was. This restored `browser/coverage.json` — a file the gate
# never touched — while `_site/coverage.json` kept the single-region, absolute-URL index built above. Any
# gate running afterwards read that instead of the real one: `nl_live_gate` opened in Amsterdam, found an
# index naming only Enschede, and reported the camera as outside coverage. The gate that leaves state
# behind is not the one that fails.
"$here/tools/build_index.sh" "$site/coverage.json" >/dev/null 2>&1 || true
exit $rc
