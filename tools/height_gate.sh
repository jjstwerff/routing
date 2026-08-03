#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# THE BLOCK CARRIES HEIGHT, and it is the height the terrain actually has (PLAN-RESTORE R2).
#
# WHAT IT ASSERTS, and why each one is here rather than assumed:
#
#   1  every step gets a height          a partly-sampled block is the silent failure — it publishes
#                                        looking finished and draws a profile with holes in it
#   2  the block is the SAME SIZE        `TStep.h` already existed and already cost its four bytes, so
#                                        filling it must change nothing. If this ever moves, the claim
#                                        "R2 is free" is wrong and the size model downstream is too
#   3  no step is left at h == 0         zero is the UNFILLED value and also a legal height at sea level;
#                                        the Netherlands is full of real zeroes, so this is checked on a
#                                        fixture that has none (Twente, 10–88 m) where the two separate
#   4  the heights match the terrain     read back through `store_load` and compared against the packed
#                                        grid at the same coordinate — the round trip, not the write
#
#   tools/height_gate.sh
#
# SKIPS (exit 0) without a terrain cache, because it is the one gate here that needs the network to set
# itself up. Fill the cache once and it is offline forever after:
#
#   tools/fetch-terrain.sh 6.75374,52.16,6.9958,52.33 12
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
tdir="${TERRAIN_DIR:-$HOME/.cache/routing-terrain}"
zoom="${TERRAIN_ZOOM:-12}"
bbox="6.75374,52.16,6.9958,52.33"          # the Enschede fixture's roads box (data/coverage.toml)
work="${TMPDIR:-/tmp}/height-gate-$$"
src="$here/browser/stores/enschede.roads.store"

mkdir -p "$work"
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f "$src" ] || fail "no fixture block at $src"
if [ ! -d "$tdir/$zoom" ]; then
  echo "SKIP: no terrain cache at $tdir/$zoom"
  echo "      tools/fetch-terrain.sh $bbox $zoom      # once, ~20 tiles / 1.8 MB"
  exit 0
fi

echo "== R2: the block carries height =="
python3 "$here/tools/pack_terrain.py" "$tdir" "$zoom" "$bbox" "$work/grid.hgt" | sed 's/^/  /' \
  || fail "pack_terrain"

cp "$src" "$work/block.store"
[ -f "$src.dschema" ] && cp "$src.dschema" "$work/block.store.dschema"
before="$(stat -c%s "$work/block.store")"

out="$("$loft" --native --lib "$here/lib" "$here/tools/gen_heights.loft" "$work/block.store" "$work/grid.hgt" 2>&1)"
grep '^#H' <<<"$out" | sed 's/^/  /'
# ⚠ These tools report failure on STDOUT and exit ZERO (see tools/cut-regions.sh) — check the text.
grep -q '#H FAIL' <<<"$out" && fail "gen_heights reported a failure"

steps="$(grep -oP '^#H tiles=\d+ steps=\K[0-9]+' <<<"$out")"
filled="$(grep -oP '^#H tiles=\d+ steps=\d+ filled=\K[0-9]+' <<<"$out")"
[ -n "$steps" ] && [ -n "$filled" ] || fail "gen_heights printed no counts"

# 1 — every step, not most of them.
[ "$filled" = "$steps" ] || fail "only $filled of $steps steps got a height"
echo "  ✔ every one of $steps steps got a height"

# 2 — filling a field that already existed must cost nothing.
after="$(stat -c%s "$work/block.store")"
[ "$after" = "$before" ] || fail "the block changed size: $before -> $after (h was supposed to be free)"
echo '  ✔ block unchanged at '"$before"' bytes — h was already in the schema'

# 3 + 4 — read it back through a normal load and check it against the grid.
cat > "$work/verify.loft" <<'LOFTEOF'
#cwd
use routing_kernel::(TTile, TRoad, TStep);
// ⚠ A BARE LOCAL, matching every other reader and matching what `gen_heights` now binds. This was a
// `struct Block { roads: … }` wrapper, which happened to agree with gen_heights while gen_heights was
// ALSO corrupting the sidecar — so the two wrongs cancelled and the gate stayed green. The moment
// gen_heights was fixed this read ZERO steps, and every assertion below passed on an empty set.
fn main() {
  a: vector<text> = [];
  for x in arguments() { a += [x]; }
  b: hash<TTile[tkey]> = [];
  store_load(b, a[0] ?? "");
  tot = 0; zero = 0; mn = 999999; mx = 0 - 999999; shown = 0;
  for t in b {
    ns = len(t.steps);
    for i in 0..ns {
      s = t.steps[i];
      if s != null {
        hv = s.h as integer;
        tot += 1;
        if hv == 0 { zero += 1; }
        if hv < mn { mn = hv; }
        if hv > mx { mx = hv; }
        if shown < 3 {
          println("#V {((t.oy + (s.y as integer)) as float) / 10000000.0} {((t.ox + (s.x as integer)) as float) / 10000000.0} {hv}");
          shown += 1;
        }
      }
    }
  }
  println("#V steps={tot} zero={zero} min={mn} max={mx}");
}
LOFTEOF
vout="$("$loft" --native --lib "$here/lib" "$work/verify.loft" "$work/block.store" 2>&1)"
grep '^#V steps' <<<"$vout" | sed 's/^/  /'
vsteps="$(grep -oP '^#V steps=\K[0-9]+' <<<"$vout")"
# ⚠ NON-VACUITY FIRST. Every assertion below is over the steps this read back, so zero steps satisfies all
# of them: the gate reported "no step left at 0" and "round-trips through store_load: 999999..-999999m"
# over an EMPTY set, in green. A read that returns nothing is a broken reader, not a clean block.
[ "${vsteps:-0}" -gt 0 ] || fail "the verify read back 0 steps — the reader cannot load what gen_heights wrote"
[ "${vsteps:-0}" = "$filled" ] || fail "verify read $vsteps steps, gen_heights filled $filled — they must be the same block"
vzero="$(grep -oP '^#V steps=\d+ zero=\K[0-9]+' <<<"$vout")"
vmin="$(grep -oP 'min=\K-?[0-9]+' <<<"$vout")"
vmax="$(grep -oP 'max=\K-?[0-9]+' <<<"$vout")"
[ "$vzero" = "0" ] || fail "$vzero steps read back at h=0 on a fixture whose terrain is 10–88 m"
[ "$vmin" -ge 0 ] && [ "$vmax" -le 400 ] || fail "heights $vmin..$vmax are outside anything the Netherlands has"
echo "  ✔ round-trips through store_load: $vmin..${vmax}m, no step left at 0"

# The write is not the round trip. Compare three real stored heights against the grid itself.
python3 - "$work/grid.hgt" <<PYEOF || fail "a stored height disagrees with the terrain grid"
import math, struct, sys
grid = sys.argv[1]
d = open(grid, "rb").read()
magic, zoom, x0, y0, cols, rows = struct.unpack("<4s5i", d[:24])
base = 24 + cols * rows
def at(lat, lon):
    n = 2 ** zoom
    xf = (lon + 180) / 360 * n
    r = math.radians(lat)
    yf = (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n
    ti = (int(yf) - y0) * cols + (int(xf) - x0)
    o = base + (ti * 65536 + int((yf - int(yf)) * 256) * 256 + int((xf - int(xf)) * 256)) * 2
    return struct.unpack("<h", d[o:o + 2])[0]
bad = 0
for line in """$(grep '^#V ' <<<"$vout" | grep -v steps=)""".strip().splitlines():
    _, lat, lon, h = line.split()
    want = at(float(lat), float(lon))
    ok = int(h) == want
    print(f"  {'✔' if ok else '✘'} {lat},{lon}: block {h}m, grid {want}m")
    bad += 0 if ok else 1
sys.exit(1 if bad else 0)
PYEOF

echo "PASS — the block carries the terrain's own heights, at no cost in bytes."
