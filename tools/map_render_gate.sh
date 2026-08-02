#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-BUILD gate — headless proof that the standalone store app renders and routes in a real browser:
#   1. map.test.mjs — the projection / pan-zoom invariant (pure math, no browser).
#   2. build-site.mjs — assemble the deployable _site (inlines the app).
#   3. drive _site/index.html in headless Chromium: `view <bbox>` renders the region on load, and a `match`
#      draws the matched route. The app fetches its stores by URL, so _site is served over HTTP (same origin).
#
# NOTE: snap-confined Chromium cannot start inside a restrictive command sandbox (run outside it).
# Requires: node, python3, chromium, and browser/store-kernel.wasm (build: node browser/build-store-kernel.mjs).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
dtport="${DTPORT:-9233}"
httpport="${HTTPPORT:-8137}"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v python3 >/dev/null || { echo "SKIP: python3 not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }

# 1. Projection invariant + the PLAN-EDIT E0 chokepoints (no browser needed).
node "$here/browser/map.test.mjs" || exit 1

# 1b. PLAN-EDIT E0 — the chokepoints must stay SINGULAR, which is a property of the SOURCE, not of a run.
# A second pointer binding or a second road to the kernel is invisible at runtime until the two disagree, and
# that is exactly how P1 (a pan appending a point) and P4 (a dropped match) survived for two months. Count
# the sites instead: the invariant is "one road in, one road out" (PLAN-EDIT §4).
echo "== PLAN-EDIT E0: the chokepoints are singular =="
e0rc=0
ptr=$(grep -cE "addEventListener\('(pointerdown|pointerup|pointermove|pointercancel|click|mousedown|mouseup|mousemove)'" "$here/browser/rough.mjs")
# ⚠ THE RULE IS ABOUT MAP INPUT, and grep cannot tell a canvas from a dropdown. What must stay singular
# is the road from a gesture ON THE MAP to a sketch edit — that is what P1 (a pan appending a point) and
# P4 (a dropped match) came from. A listener on a named piece of CHROME is not on that road: the search
# results list is a menu, and routing its clicks through the map's pointer dispatcher would be worse, not
# better.
#
# So chrome receivers are exempt BY NAME, and the exemptions are printed. That keeps the property the
# rule is really asserting ("no second road into the sketch") while making each exception a deliberate
# line in this file rather than something a grep happened not to see.
# `routeGpxBtn` is the GPX download button in the route bar (PLAN-LAYERS §5b) — named chrome that turns
# the route already on screen into a file, and touches the sketch not at all.
chrome_rx="(list|box|btn|snack|input|sel|aSel|sSel|routeGpxBtn)\\."
stray=$(grep -nE "addEventListener\('(pointerdown|pointerup|pointermove|pointercancel|click|mousedown|mouseup|mousemove)'" \
        "$here/browser/store-app.mjs" "$here/browser/map.mjs" 2>/dev/null \
        | grep -vE ":[[:space:]]*$chrome_rx" || true)
exempt=$(grep -cE "addEventListener\('(click|mousedown|mouseup)'" "$here/browser/store-app.mjs" 2>/dev/null || echo 0)
if [ -n "$stray" ]; then
  echo "  FAIL: a pointer/click listener lives outside rough.mjs — input dispatch is no longer a chokepoint:"; echo "$stray"; e0rc=1
elif [ "$ptr" -lt 4 ]; then
  echo "  FAIL: rough.mjs binds $ptr pointer listeners (expected the 4 of the one dispatcher)"; e0rc=1
else
  echo "  ✓ every MAP pointer listener is in rough.mjs ($ptr of them, one dispatcher); $exempt chrome listener(s) exempt"
fi
# PLAN-LAYERS §5c — EVERY CDP DRIVER MUST CLEAR local storage before it navigates.
#
# The app autosaves the sketch there, and every gate launches chromium with a PERSISTENT
# `--user-data-dir`, so one run's sketch restores into the next run's assertions — a restored sketch
# re-matches at boot, which moves the range-read and match counters other gates assert on. store-app.mjs's
# camera comment named this exact failure as the reason the camera is NOT in localStorage, and named its
# cure's weak point too: "staying deterministic would have meant clearing storage in all seven, with the
# eighth forgetting to". This is the eighth-forgetting check. A new driver fails here until it clears.
missing=""
for drv in "$here"/browser/cdp_*.mjs; do
  grep -q "Page.navigate" "$drv" || continue                  # not a driver that boots a page
  grep -q "clearDataForOrigin" "$drv" || missing="$missing $(basename "$drv")"
done
if [ -n "$missing" ]; then
  echo "  FAIL: CDP driver(s) navigate without clearing local storage —$missing"
  echo "        add: await call('Storage.clearDataForOrigin', { origin: new URL(<url>).origin, storageTypes: 'local_storage' });"
  e0rc=1
else
  echo "  ✓ every CDP driver clears local storage before navigating (the sketch autosave cannot leak between runs)"
fi

# Reaching the kernel outside the queue re-opens P4 — and `runKernel` keeps ONE resolve slot, so a second
# road to it does not merely race, it orphans a promise. The APP section (everything above the test-only
# __perfHooks block, which measures the kernel in isolation on purpose) must hold exactly three calls:
# the `view` inside ensureViewNow, the `match` inside streamedMatch, and the `find` inside initSearch's
# `run` — each the body of a queued job.
#
# The COUNT is a proxy for the real rule, which is "every one of them is inside jobs.post". Raising it is
# therefore allowed, and adding a call outside the queue is not; if you raise it, name the third here so
# the next reader can tell an intended road from a smuggled one.
app_end=$(grep -n 'window.__perfHooks = {' "$here/browser/store-app.mjs" | head -1 | cut -d: -f1)
app_calls=$(head -n "${app_end:-0}" "$here/browser/store-app.mjs" | grep -c 'kernel.runKernel')
if [ "$app_calls" -ne 3 ]; then
  echo "  FAIL: the app reaches the kernel from $app_calls places (expected 3 — ensureViewNow + streamedMatch + initSearch);"
  echo "        a third is a road around the queue, which is how a match gets dropped (P4)."
  head -n "${app_end:-0}" "$here/browser/store-app.mjs" | grep -n 'kernel.runKernel'
  e0rc=1
else
  echo "  ✓ the app reaches the kernel from exactly 3 places (view, match, find), each inside a queued job"
fi
[ $e0rc -eq 0 ] || exit 1

# 1a-cover. EVERY COVER `area_use` CAN RETURN MUST HAVE A TREATMENT.
#
# `leisure=nature_reserve` fell through area_use to "other", the renderer had no colour for "other", and
# the opaque fallback painted 270 ha of Landgoed Hof Espelo and 552 ha of Lonnekerberg flat over the
# forest and grass correctly stored beneath them. One unmapped OSM value, two buried landscapes, and
# nothing anywhere said so. The generator and the renderer each looked complete on their own; only the
# PAIR was wrong, which is exactly the kind of gap a gate has to hold.
echo "== every landcover the generator emits has a renderer treatment =="
covers="$(sed -n '/^pub fn area_use/,/^}/p' "$here/lib/basemap/src/basemap.loft" \
          | grep -oE 'return "[a-z_]+"' | cut -d'"' -f2 | sort -u)"
styled="$(node -e "import('$here/browser/map.mjs').then(m=>console.log(Object.keys(m.COVER_COLORS).join('\n')))" 2>/dev/null)"
# "other" is the deliberate unknown (draws nothing); the overlay kinds come from the module itself, so
# adding a designation cannot drift the gate out of step with the renderer.
overlay="other $(node -e "import('$here/browser/map.mjs').then(m=>console.log(Object.keys(m.DESIGNATION_STYLES).join(' ')))" 2>/dev/null)"
missing=""
for c in $covers; do
  case " $overlay " in *" $c "*) continue ;; esac
  echo "$styled" | grep -qx "$c" || missing="$missing $c"
done
[ -n "$covers" ] || { echo "  FAIL: parsed no covers out of area_use — the gate is blind"; exit 1; }
echo "$styled" | grep -qx forest || { echo "  FAIL: could not read COVER_COLORS from map.mjs"; exit 1; }
echo "$overlay" | grep -q reserve || { echo "  FAIL: no DESIGNATION_STYLES — designations would draw nothing"; exit 1; }
if [ -n "$missing" ]; then
  echo "  FAIL: area_use can return$missing, which the renderer has no colour for —"
  echo "        it would paint nothing, or (worse) an opaque unknown over real terrain."
  exit 1
fi
echo "  ✓ $(echo "$covers" | wc -w) covers, each either coloured or explicitly an overlay/unknown"

# 1a-road. EVERY ROAD CLASS THE STORE CAN EMIT MUST BE NAMED, AND EVERY NAME MUST HAVE A STYLE.
#
# Two functions and a renderer have to agree: `class_of` (tools/gen-tiles.loft) picks the class stored in
# the block, `class_name` (lib/map_kernel/src/map_kernel.loft) turns it back into a name for the view, and
# ROAD_STYLES draws it. Classes 12/13/14 had no case in class_name and fell through its `else` to
# "residential", so a farm TRACK drew as a white street; `service` had a name but no ROAD_STYLES row, so
# every service road was silently dropped by `if (!style) continue` — that is Lonnekeresweg, a real dirt
# road missing from a real map.
#
# ⚠ THE CHECK IS FOR AN EXPLICIT CASE, not for a name that merely resolves. class_name's `else` gives
# every integer an answer, so "does it produce a style?" is always yes and would have passed throughout.
echo "== every road class is named, and every name is drawable =="
node - "$here" <<'NODE' || exit 1
const fs = require('fs'), path = require('path'), here = process.argv[2];
const read = (p) => fs.readFileSync(path.join(here, p), 'utf8');
const emitted = new Set([...read('tools/gen-tiles.loft').matchAll(/return\s+(\d+)\s*;/g)].map(m => +m[1]));
const nameFn = read('lib/map_kernel/src/map_kernel.loft').split('fn class_name')[1].split('\n}')[0];
const named = new Map([...nameFn.matchAll(/tp\s*==\s*(\d+)\s*\{\s*"([a-z_]+)"/g)].map(m => [+m[1], m[2]]));
import('file://' + path.join(here, 'browser/map.mjs')).then((M) => {
  const styles = new Set(Object.keys(M.ROAD_STYLES));
  const order = new Set(M.ROAD_ORDER || []);
  const unnamed = [...emitted].filter((c) => !named.has(c)).sort((a, b) => a - b);
  const unstyled = [...new Set([...named.values()])].filter((n) => !styles.has(n)).sort();
  // A style with no place in ROAD_ORDER is collected by the draw loop and never stroked — invisible in
  // exactly the way a missing style is, and NOT caught by checking ROAD_STYLES alone. That gap kept
  // Amelinklaan's 11 service ways off the map after the style for them had already landed.
  const undrawn = [...new Set([...named.values()])].filter((n) => styles.has(n) && !order.has(n)).sort();
  if (unnamed.length) {
    console.log(`  FAIL: class_of emits ${unnamed.join(', ')} with no case in class_name —`);
    console.log('        they fall through its `else` and draw as something else entirely.');
  }
  if (unstyled.length) {
    console.log(`  FAIL: class_name returns ${unstyled.join(', ')}, which ROAD_STYLES cannot draw —`);
    console.log('        an unknown class is skipped, so those roads vanish from the map.');
  }
  if (undrawn.length) {
    console.log(`  FAIL: ${undrawn.join(', ')} have a ROAD_STYLES row but no place in ROAD_ORDER —`);
    console.log('        the draw loop buckets them and strokes nothing, so they never appear.');
  }
  if (!emitted.size || !named.size || !styles.size || !order.size) { console.log('  FAIL: parsed nothing — the gate is blind'); process.exit(1); }
  if (unnamed.length || unstyled.length || undrawn.length) process.exit(1);
  console.log(`  \u2713 ${emitted.size} classes, each explicitly named, styled AND in the draw order`);
}).catch((e) => { console.log('  FAIL: ' + e.message); process.exit(1); });
NODE

# 1a. PLAN-PERF §6e — is the browser kernel threaded? `par` (step 18) is a no-op while it is not.
echo "== step 18 tripwire: browser kernel threading =="
node "$here/tools/wasm_threads.mjs" || exit 1

# 1b. Is the shipped wasm actually built from the kernel sources in the tree?
#
# Everything below this line tests browser/store-kernel.wasm, which is COMMITTED and rebuilt by hand
# (node browser/build-store-kernel.mjs). So a kernel change can land in the .loft sources, pass every
# native gate, and be entirely absent from what the browser runs — the gate would stay green while
# testing the previous kernel. That is the drift this checks for.
#
# FATAL since 2026-07-30: loft#681 is fixed, so `node browser/build-store-kernel.mjs` works again and a
# stale wasm is now a defect rather than an unfixable condition. (It warned for exactly one afternoon.)
# This compares a HASH OF THE SOURCES, not mtimes. It used to be `find <kernel srcs> -newer <wasm>`,
# which reads whatever order the last checkout wrote files in — GIT DOES NOT PRESERVE MTIMES. Measured
# right after a merge on 2026-07-31: wasm at 08:03:23.568, routing_kernel.loft at 08:03:23.588, same
# checkout, nothing edited, and a correct wasm was called STALE. The direction that actually costs you
# is the reverse — a genuinely stale wasm written last would have PASSED, and catching that is the
# whole point of this check.
stale_is_fatal=1
echo "== is the shipped kernel wasm current? =="
sidecar="$here/browser/store-kernel.wasm.sources"
want="$([ -f "$sidecar" ] && tr -d '[:space:]' < "$sidecar")"   # test first: a bare `< missing` errors in the SHELL, before tr can be silenced
have="$(node "$here/browser/build-store-kernel.mjs" --print-source-hash 2>/dev/null | tr -d '[:space:]')"
if [ -z "$have" ]; then
  echo "  ⚠ could not hash the kernel sources (is node on PATH?)"
  [ "$stale_is_fatal" = "1" ] && exit 1
elif [ -z "$want" ]; then
  echo "  ⚠ STALE: no browser/store-kernel.wasm.sources — the shipped wasm names no sources,"
  echo "      so nothing can say which kernel the browser is running."
  echo "      rebuild: node browser/build-store-kernel.mjs"
  [ "$stale_is_fatal" = "1" ] && exit 1
elif [ "$want" != "$have" ]; then
  echo "  ⚠ STALE: browser/store-kernel.wasm was built from DIFFERENT kernel sources —"
  echo "      shipped from ${want:0:12}…, tree is ${have:0:12}…"
  echo "      the browser is running the PREVIOUS kernel; everything below tests that, not the tree."
  echo "      rebuild: node browser/build-store-kernel.mjs"
  [ "$stale_is_fatal" = "1" ] && exit 1
else
  echo "  ✓ store-kernel.wasm is built from the kernel sources in the tree (${have:0:12}…)"
fi

# 2. Build the deployable site, and the TOP INDEX the app resolves its blocks through (PLAN-SCALE S7).
# The index is generated from the manifest and the blocks themselves, never edited, so the gate rebuilds
# it rather than trusting the copy in the tree — a stale index is the failure it exists to prevent.
SITE_LOCAL_ONLY=1 node "$here/browser/build-site.mjs" || exit 1
"$here/tools/build_index.sh" >/dev/null || { echo "  FAIL: could not build the coverage index"; exit 1; }
echo "  ✓ coverage index: $(grep -oP '"id":"\K[^"]+' "$here/_site/coverage.json" | tr '\n' ' ')"
[ -f "$here/browser/store-kernel.wasm" ] || { echo "SKIP: browser/store-kernel.wasm missing (run: node browser/build-store-kernel.mjs)"; exit 2; }

# 3. Serve _site + drive it in headless Chromium.
rm -rf "$here/scratch/chromium-$dtport"; mkdir -p "$here/scratch"
srv=""; chr=""; rc=0
cleanup() { kill "$chr" "$srv" 2>/dev/null; }
trap cleanup EXIT
# PLAN-SCALE C1b: the kernel reads its roads block by BYTE RANGE now, and `python3 -m http.server` does
# not implement Range at all — it would answer every page request with the whole 3.5 MB file. The shim
# slices a 200 so the answer stays correct, but the gate would be measuring the wrong thing entirely.
python3 "$here/tools/range_server.py" "$httpport" "$here/_site" /dev/null >/dev/null 2>&1 &
srv=$!
"$chromium" --headless=new --disable-gpu --no-sandbox --window-size=1000,700 \
  --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port="$dtport" about:blank >/dev/null 2>&1 &
chr=$!
sleep 4

echo "== PLAN-BUILD store-app gate (view <bbox> + match, headless HTTP) =="
node "$here/browser/cdp_verify_store.mjs" "127.0.0.1:$dtport" "http://127.0.0.1:$httpport/index.html" || rc=1

# 4. The deployed artifact must be self-contained (all modules inlined — no external .mjs to trip Pages MIME).
if grep -qE 'src="\./[A-Za-z0-9_-]+\.mjs"' "$here/_site/index.html"; then
  echo "  FAIL: _site/index.html references an external .mjs (not inlined)"; rc=1
else
  echo "  ✓ _site/index.html is self-contained (modules inlined)"
fi
exit $rc
