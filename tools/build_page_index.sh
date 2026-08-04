#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Build the PAGE INDEX for one block: which 64 kB pages does each cell need?
#
# `docs/prefetch-index-design.md` — the app pays 764 SERIAL round trips for a cold viewport, and the
# reads are latency-bound (a 64 kB range costs the same as one byte). Knowing the pages ahead of time
# turns that into one parallel batch. This produces the knowing.
#
# ⚠ THE OFFSETS ARE LOGGED SERVER-SIDE, ON PURPOSE. `LOFT_LOADER_STATS=1` reports a histogram
# (`reads=[(2,36,144), …]` — level, count, bytes) and no offsets, so it cannot build an index. Serving
# the block over HTTP Range and recording what the loader ASKS FOR needs nothing from loft's internals
# and cannot drift when they change: the wire is the interface.
#
# ⚠ AND ONE PROCESS PER CELL, deliberately. `store_load_keys` ACCUMULATES, so a loop inside one program
# would record cell N's pages against a store already holding cells 1..N-1 — the index would then be
# correct only for that traversal order. A cold process per cell is the only way to record what a cell
# costs BY ITSELF, which is what a client union needs. It is also the design's own open question
# (§6, accumulation): this tool answers it by construction rather than assuming it away.
#
#   tools/build_page_index.sh <block.store> <PTile|TTile> [out.json]
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
block="${1:-}"; kind="${2:-PTile}"; out="${3:-}"
[ -f "$block" ] || { echo "usage: build_page_index.sh <block.store> <PTile|TTile> [out.json]"; exit 2; }
name="$(basename "$block")"; out="${out:-$here/blocks/$name.pages.json}"
port="${PAGEIDX_PORT:-8477}"; PAGE=65536
command -v python3 >/dev/null || { echo "SKIP: python3"; exit 2; }

w="$(mktemp -d)"; trap 'rm -rf "$w"; [ -n "${srv:-}" ] && kill "$srv" 2>/dev/null; return 0 2>/dev/null || true' EXIT
cp "$block" "$w/b.store"; [ -f "$block.dschema" ] && cp "$block.dschema" "$w/b.store.dschema"
sha="$(sha256sum "$block" | cut -d' ' -f1)"
bytes="$(stat -c%s "$block")"

# ⚠ THE PROVEN SERVER, NOT A SECOND ONE. The first version of this shipped its own tiny range server and
# it was WRONG in a way that silently corrupted the index: it omitted `Accept-Ranges: bytes`, so the
# loader probed with a plain GET and then read differently — 12.2 pages per cell recorded against a true
# 3, and 278 whole-file fetches where there should be none. `tools/range_server.py` already serves every
# browser gate here; it now logs what was ASKED FOR under RANGE_LOG, so the recording cannot drift from
# what the app actually experiences.
: > "$w/reads.log"
RANGE_LOG="$w/reads.log" python3 "$here/tools/range_server.py" "$port" "$w" /dev/null >/dev/null 2>&1 &
srv=$!
sleep 1

# Every cell key in the block.
cat > "$w/keys.loft" <<LOFT
#cwd
use basemap::PTile;
use routing_kernel::TTile;
fn main() {
  ws: hash<$kind[tkey]> = [];
  store_load(ws, "b.store");
  for t in ws { println("K {t.tkey}"); }
}
LOFT
mapfile -t keys < <(cd "$w" && "$loft" --native --lib "$here/lib" keys.loft 2>/dev/null | sed -n 's/^K //p')
[ "${#keys[@]}" -gt 0 ] || { echo "FAIL: no cells read out of $name (wrong record type? tried $kind)"; exit 1; }
echo "== page index for $name =="
echo "   $bytes bytes · $(( (bytes + PAGE - 1) / PAGE )) pages of 64 kB · ${#keys[@]} cells · $kind"

# One key per run, read from argv so the source compiles ONCE.
cat > "$w/one.loft" <<LOFT
#cwd
use basemap::PTile;
use routing_kernel::TTile;
fn main() {
  a = arguments();
  ws: hash<$kind[tkey]> = [];
  k = a[1] as integer ?? 0;
  _ = store_load_key(ws, a[0]? , k);
}
LOFT
url="http://127.0.0.1:$port/b.store"
( cd "$w" && "$loft" --native --lib "$here/lib" one.loft "$url" "${keys[0]}" >/dev/null 2>&1 )  # warm the build cache

python3 - "$w" "$url" "$out" "$name" "$sha" "$bytes" "$PAGE" "$here" "$loft" "$kind" "${keys[@]}" <<'PY'
import json, os, re, subprocess, sys
w, url, out, name, sha, nbytes, PAGE, here, loft, kind = sys.argv[1:11]
keys = sys.argv[11:]
PAGE = int(PAGE); nbytes = int(nbytes)
logp = os.path.join(w, 'reads.log')
idx, whole, total_refs, probes = {}, 0, 0, 0
for i, k in enumerate(keys):
    before = os.path.getsize(logp)
    subprocess.run([loft, '--native', '--lib', os.path.join(here, 'lib'), 'one.loft', url, k],
                   cwd=w, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(logp) as f:
        f.seek(before); lines = f.read().splitlines()
    pages = set()
    for ln in lines:
        # ⚠ ONLY A WHOLE READ OF THE STORE IS A FALLBACK. The `.dschema` sidecar is ALWAYS fetched
        # without a Range — it has to be — so counting every non-ranged GET made this guard fire once per
        # cell and call a perfectly good run broken. Two wrong diagnoses came out of that before the log
        # was simply read: it is the sidecar, every time.
        if ln.startswith('WHOLE'):
            if '.dschema' not in ln: whole += 1
            continue
        m = re.search(r'bytes=(\d*)-(\d*)', ln)
        if not m: continue
        lo, hi = m.group(1), m.group(2)
        if lo == '': continue                     # suffix form, not a page read
        off = int(lo); last = int(hi) if hi else off
        # `bytes=0-0` is the loader's SIZE PROBE (it reads the total off Content-Range), not a page it
        # needs. Counting it would put page 0 in every cell's set and overstate the union by one page.
        if off == 0 and last == 0: probes += 1; continue
        for pg in range(off // PAGE, last // PAGE + 1): pages.add(pg)
    idx[k] = sorted(pages); total_refs += len(pages)
    if (i + 1) % 25 == 0 or i + 1 == len(keys):
        print(f"   {i+1}/{len(keys)} cells · {total_refs} page refs", flush=True)

allp = sorted({p for v in idx.values() for p in v})
doc = {'block': name, 'sha256': sha, 'bytes': nbytes, 'page': PAGE,
       'pages_total': (nbytes + PAGE - 1) // PAGE, 'record': kind, 'cells': idx}
with open(out, 'w') as f: json.dump(doc, f, separators=(',', ':'))
print(f"   distinct pages touched : {len(allp)} of {(nbytes+PAGE-1)//PAGE}")
print(f"   mean pages per cell    : {total_refs/max(len(keys),1):.1f}")
print(f"   size probes (bytes=0-0): {probes}  (one per cell — not a page, excluded from the index)")
print(f"   whole STORE reads      : {whole}  (want 0 — a whole read means the key path fell back)")
print(f"   index written          : {out}  ({os.path.getsize(out)} bytes)")
PY
