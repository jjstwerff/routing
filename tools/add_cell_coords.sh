#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Give a page index a SPATIAL key, so the browser can actually use it.
#
# `build_page_index.sh` keys pages by `tkey` — loft's cell key. The browser cannot look that up: JS works
# in bounding boxes (`viewportBox`) and never computes a tkey; only loft does. So the index as generated
# is unusable from the place that needs it.
#
# Every tile already carries `ox`/`oy` — its origin in fixed-point 1e-7 degrees, the SAME space
# `coverage.json` states every bbox in. Adding those two numbers per cell lets JS select cells by
# viewport with no key arithmetic and no duplicated loft logic.
#
# A separate pass on purpose: it is ONE `store_load` per block against an index that already exists,
# rather than regenerating 275 177 cells to add two integers.
#
#   tools/add_cell_coords.sh <block.store> <PTile|TTile>
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
block="${1:-}"; kind="${2:-PTile}"
[ -f "$block" ] || { echo "usage: add_cell_coords.sh <block.store> <PTile|TTile>"; exit 2; }
name="$(basename "$block")"; idx="$here/blocks/$name.pages.json"
[ -f "$idx" ] || { echo "SKIP: no index at $idx — run build_page_index.sh first"; exit 2; }

w="$(mktemp -d)"; trap 'rm -rf "$w"' EXIT
cat > "$w/coords.loft" <<LOFT
#cwd
use basemap::PTile;
use routing_kernel::TTile;
fn main() {
  ws: hash<$kind[tkey]> = [];
  store_load(ws, "$here/blocks/$name");
  for t in ws { println("C {t.tkey} {t.ox} {t.oy}"); }
}
LOFT
( cd "$w" && "$loft" --native --lib "$here/lib" coords.loft 2>/dev/null | sed -n 's/^C //p' > "$w/coords.txt" )
n="$(wc -l < "$w/coords.txt")"
[ "$n" -gt 0 ] || { echo "FAIL: no coordinates read out of $name"; exit 1; }

python3 - "$idx" "$w/coords.txt" <<'PY'
import json, sys, os
idxp, coordp = sys.argv[1], sys.argv[2]
d = json.load(open(idxp))
co = {}
for ln in open(coordp):
    p = ln.split()
    if len(p) == 3: co[p[0]] = (int(p[1]), int(p[2]))
cells = d['cells']
missing = [k for k in cells if k not in co]
# `xy` is a parallel map rather than a change to `cells`, so an older reader still works and a newer one
# can tell "no coordinates yet" from "cell not in the index".
d['xy'] = {k: list(co[k]) for k in cells if k in co}
if d['xy']:
    xs = [v[0] for v in d['xy'].values()]; ys = [v[1] for v in d['xy'].values()]
    d['extent'] = {'mnlo': min(xs), 'mxlo': max(xs), 'mnla': min(ys), 'mxla': max(ys)}
before = os.path.getsize(idxp)
json.dump(d, open(idxp, 'w'), separators=(',', ':'))
print(f"   {len(d['xy'])}/{len(cells)} cells given coordinates"
      + (f"  ⚠ {len(missing)} without" if missing else ""))
if d.get('extent'):
    e = d['extent']
    print(f"   extent  lon {e['mnlo']/1e7:.4f}..{e['mxlo']/1e7:.4f}   lat {e['mnla']/1e7:.4f}..{e['mxla']/1e7:.4f}")
print(f"   index   {before} -> {os.path.getsize(idxp)} bytes")
PY
