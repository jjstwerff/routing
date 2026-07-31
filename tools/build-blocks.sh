#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Generate a routing block from OpenStreetMap (PLAN-SCALE §7 R1–R5).
#
# This is the pipeline the plan calls the recurring cost: acquire → filter → export → generate → verify.
# It is written to be run again and again, which is the only way a dataset stays current, so every step is
#
#   RESUMABLE   each step skips when its output is newer than its input, so a run interrupted anywhere
#               continues instead of restarting. A country takes long enough that this is not a luxury.
#   AUDIBLE     every step prints what it produced. A pipeline whose middle is silent is one you cannot
#               debug at 2 GB.
#   VERIFIED    the block is opened, measured and spot-checked before it is offered to the index. A block
#               that generated "successfully" but lost its western half is the failure this catches.
#
#   tools/build-blocks.sh <region-id> <geofabrik-path> [bbox]
#     region-id       e.g. netherlands            (names the outputs)
#     geofabrik-path  e.g. europe/netherlands     (without -latest.osm.pbf)
#     bbox            optional W,S,E,N to clip    (osmium extract; omit for the whole extract)
#
#   e.g. tools/build-blocks.sh netherlands europe/netherlands
#        tools/build-blocks.sh gelderland  europe/netherlands 5.0,51.7,6.9,52.5
#
# Needs: osmium-tool (apt install osmium-tool), curl, and the loft on PATH.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
id="${1:-}"; src="${2:-}"; bbox="${3:-}"
[ -n "$id" ] && [ -n "$src" ] || { sed -n '/^#   tools\/build-blocks.sh/,/^#$/p' "$0" | sed 's/^# \?//'; exit 2; }
command -v osmium >/dev/null || { echo "FAIL: osmium-tool not installed (apt install osmium-tool)"; exit 1; }

# Everything lives outside the repo: a 1.4 GB extract and its intermediates are not source.
work="${BLOCKS_WORK:-$HOME/.cache/routing-blocks}"
# Generated blocks live in a gitignored `blocks/` — `_site` is WIPED and rebuilt by build-site.mjs,
# so a 322 MB block written there disappears at the next gate run.
out="${BLOCKS_OUT:-$here/blocks}"
mkdir -p "$work" "$out"
pbf="$work/$(basename "$src")-latest.osm.pbf"
clip="$work/$id.clip.osm.pbf"
roads="$work/$id.roads.osm.pbf"
seq="$work/$id.geojsonseq"
store="$out/$id.roads.store"
newer() { [ -s "$1" ] && [ "$1" -nt "$2" ]; }   # $1 exists and is newer than $2

# --- R1 · acquire, resumably ----------------------------------------------------------------------
url="https://download.geofabrik.de/$src-latest.osm.pbf"
part="$pbf.part"
echo "== R1 acquire =="

# ⚠ NEVER DOWNLOAD ONTO THE CACHED EXTRACT. It used to `curl -o "$pbf" -C -` straight over it, and the
# two halves of that are individually reasonable and together destroy the cache: `-C -` RESUMES from the
# local size, which is only valid when the remote bytes are the same file — and the branch that runs it
# fires precisely when upstream has CHANGED. Measured 2026-07-31: local 1394919798 bytes, upstream
# 1395001098, so curl appended ~81 KB of the new extract onto the old one and produced a file of exactly
# the right length that md5 rejected and osmium could not open ("invalid BlobHeader size"). The good
# 1.3 GB cache was gone, and the failure surfaced as a mystery in a step that had not run yet.
#
# So: fetch to a sidecar, verify the SIDECAR, and only then let it become the cache. A failed download
# now costs a retry instead of the copy that was working.
verify() {  # $1 = file to check against the published md5 → 0 ok, 1 mismatch, 2 no md5 published
  curl -sfL "$url.md5" -o "$part.md5" || return 2
  # Compare the HASH, not the filename: geofabrik's .md5 names the DATED file (netherlands-260729…), so
  # `md5sum -c` would look for a name that does not exist here and fail for the wrong reason.
  local want have
  want="$(cut -d' ' -f1 "$part.md5")"; have="$(md5sum "$1" | cut -d' ' -f1)"
  [ "$want" = "$have" ] && return 0
  echo "FAIL: md5 mismatch ($(stat -c%s "$1") bytes)"; echo "      want $want"; echo "      have $have"
  return 1
}

need=1
if [ -s "$pbf" ]; then
  echo "  have $(basename "$pbf") ($(du -h "$pbf" | cut -f1)) — checking it is still current"
  remote="$(curl -sIL "$url" | grep -i '^content-length' | tail -1 | tr -dc '0-9')"
  local_sz="$(stat -c%s "$pbf")"
  if [ -z "$remote" ] || [ "$remote" = "$local_sz" ]; then need=0
  else echo "  upstream changed ($local_sz → $remote) — re-fetching to $(basename "$part")"; fi
fi

if [ "$need" = 1 ]; then
  # `-C -` is safe HERE: it resumes the sidecar, which is our own partial of this same fetch.
  curl -# -L -o "$part" -C - "$url" || { echo "FAIL: download"; rm -f "$part"; exit 1; }
  verify "$part"; rc=$?
  if [ "$rc" = 1 ]; then
    rm -f "$part"                     # a bad partial must not survive to be "resumed" into the next run
    echo "      discarded the partial; the previous extract is untouched. Re-run to try again."
    exit 1
  fi
  [ "$rc" = 2 ] && echo "  (no published md5 — proceeding unverified)"
  mv -f "$part" "$pbf"
  echo "  fetched + verified ($(du -h "$pbf" | cut -f1))"
else
  echo "  up to date ($(du -h "$pbf" | cut -f1))"
fi

# --- R2 · per-region osmium passes ----------------------------------------------------------------
echo "== R2 extract + filter =="
if [ -n "$bbox" ]; then
  # ⚠ THE BBOX IS PART OF THE CLIP'S IDENTITY. Keyed on mtime alone, a re-run with a DIFFERENT box
  # reported "clip up to date" and reused the previous region — so a bbox change silently did nothing,
  # and any measurement taken across two boxes compared one box with itself. Same failure as the
  # recipe-keying fix in build-base.sh; the box is this step's recipe.
  cfp="$clip.bbox"
  if [ ! -f "$cfp" ] || [ "$(cat "$cfp" 2>/dev/null)" != "$bbox" ]; then
    [ -s "$clip" ] && echo "  bbox changed — discarding the cached clip"
    rm -f "$clip" "$cfp"
  fi
  if newer "$clip" "$pbf"; then echo "  clip up to date"; else
    echo "  osmium extract --bbox $bbox"
    osmium extract --bbox "$bbox" --overwrite -o "$clip" "$pbf" || { echo "FAIL: osmium extract"; exit 1; }
    printf '%s' "$bbox" > "$cfp"
  fi
  base_pbf="$clip"
else
  base_pbf="$pbf"
fi
# ⚠ RESUMABILITY IS KEYED ON THE RECIPE TOO, not just on mtimes. These steps skip when their output is
# newer than their input — which silently reused a way-only `geojsonseq` the day `n/barrier` and
# `--geometry-types=…,point` were added here, and produced a "successfully regenerated" country block
# with zero barriers in it. The fingerprint below is the filter+export recipe; change either and the
# cached intermediates are stale by definition.
recipe="w/highway n/barrier | linestring,point"
rfp="$work/$id.recipe"
if [ ! -f "$rfp" ] || [ "$(cat "$rfp" 2>/dev/null)" != "$recipe" ]; then
  echo "  recipe changed — discarding cached filter/export intermediates"
  rm -f "$roads" "$seq"
  printf '%s' "$recipe" > "$rfp"
fi
if newer "$roads" "$base_pbf"; then echo "  roads filter up to date"; else
  echo "  osmium tags-filter w/highway n/barrier"
  # BOTH ways and barrier NODES. A gate across a path is a node, so a way-only filter cannot see one —
  # `w/highway` alone left 19 gates, 5 swing gates and 2 lift gates invisible in a single Enschede box,
  # and the router walked through all of them.
  osmium tags-filter --overwrite -o "$roads" "$base_pbf" w/highway n/barrier \
    || { echo "FAIL: osmium tags-filter"; exit 1; }
fi
echo "  roads pbf: $(du -h "$roads" | cut -f1)"

# --- R2b · export the form the generator streams ---------------------------------------------------
# geojsonseq, one Feature per line — which `gen-tiles` reads directly (PLAN-SCALE S6). The older recipe
# converted this to Overpass-shaped JSON first; streaming removed that step entirely.
echo "== R2b export geojsonseq =="
if newer "$seq" "$roads"; then echo "  geojsonseq up to date"; else
  # …and export points alongside linestrings, or the barrier nodes just filtered in are dropped here.
  osmium export "$roads" -f geojsonseq --geometry-types=linestring,point --overwrite -o "$seq" \
    || { echo "FAIL: osmium export"; exit 1; }
fi
echo "  geojsonseq: $(du -h "$seq" | cut -f1), $(wc -l < "$seq") features"

# --- R4 · generate ---------------------------------------------------------------------------------
echo "== R4 generate =="
if newer "$store" "$seq"; then echo "  block up to date"; else
  rm -f "$store" "$store.dschema"
  time "$loft" --native-release --lib "$here/lib" "$here/tools/gen-tiles.loft" "$store" "$seq" \
    || { echo "FAIL: gen-tiles"; exit 1; }
fi
echo "  block: $(du -h "$store" | cut -f1)"

# --- R5 · verify BEFORE it is offered to anything --------------------------------------------------
echo "== R5 verify =="
ext="$("$loft" --native --lib "$here/lib" "$here/tools/store_extent.loft" "$store" roads 2>/dev/null | grep -oP '^EXTENT \K.*')"
[ -n "$ext" ] || { echo "FAIL: the block does not open"; exit 1; }
set -- $ext
echo "  extent lat $(python3 -c "print(f'{$1/1e7:.4f}..{$3/1e7:.4f}')") lon $(python3 -c "print(f'{$2/1e7:.4f}..{$4/1e7:.4f}')") · tiles=$5 roads=$6"
[ "$5" -ge 100 ] || { echo "FAIL: only $5 tiles — the block is empty or the filter dropped everything"; exit 1; }
# A paged spot check: the read path the client uses, on the block it will actually read.
LOFT_LOADER_STATS=1 "$loft" --native --lib "$here/lib" "$here/tools/page_locality_probe.loft" "$store" 2>&1 \
  | grep -E '^store_load_keys|^asked' | sed 's/^/  /'

# The box the block was cut from, recorded BESIDE it. Without this, nothing downstream can tell whether a
# source export and a block describe the same ground — and a count comparison between two different boxes
# is not a measurement in either direction.
printf '%s' "${bbox:-<whole-extract>}" > "$store.bbox"
# …and the source count from the very export this block was built from. Comparing a block against a
# LATER export measures OSM drift, not loss: the shipped block reads 94.6% of today's extract purely
# because the extract is two days newer. Recorded at build time, the comparison has one run on both sides.
grep -c '"highway"' "$seq" 2>/dev/null > "$store.srccount" || true

cat <<EOF

Block ready: $store
Next:
  1. add it to data/coverage.toml   (id = "$id", roads = "stores/$(basename "$store")")
     — build-site.mjs copies blocks/ into _site/stores/, so the URL stays "stores/…"
  2. tools/build_index.sh           (re-derives extents, sizes and hashes)
  3. tools/cross_block_browser_gate.sh + make test-map
EOF
