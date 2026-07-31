#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Build the TOP INDEX from the coverage manifest (PLAN-SCALE S7 / D6 / §7 R0+R6).
#
# The index is the only thing this project authors about its data: bbox → which block covers it, where it
# lives, how big it is, its sha256, and how to read it. Everything else — the directory of tiles, the byte
# ranges — is the store's own business, which is why the index stays a few hundred bytes per block instead
# of a format of its own.
#
# Three properties it is built to have:
#   * THE EXTENT IS MEASURED, NEVER DECLARED. Each block is opened and its real extent read out
#     (tools/store_extent.loft). A manifest bbox that outran its data would be a hole in the map that the
#     index insisted was covered.
#   * THE HASH IS THE POINT OF PUBLISHING (§7 R6). With it the client can load through `store_load_url`,
#     which VERIFIES, instead of the trusted twin — and at WE scale the blocks sit on third-party storage.
#   * IT IS REGENERATED, NOT EDITED. A hand-corrected index is one that no longer describes the files.
#
#   tools/build_index.sh [out.json]        # default: browser/coverage.json (the COMMITTED index)
#   DATASET_VERSION=v2026-07-30 tools/build_index.sh …    # name the dataset explicitly
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
# Overridable so a gate can point the same generator at a temporary manifest — e.g. one that
# publishes a region at a cross-origin host to prove the CORS path.
manifest="${COVERAGE_MANIFEST:-$here/data/coverage.toml}"
# At the SITE ROOT, not inside stores/: the block URLs in the manifest are relative to the root, and a
# URL is resolved against the file that CONTAINS it. An index one directory down turns "stores/x.store"
# into "stores/stores/x.store" — every block 404s and the app boots into an empty map.
# Default output is the COMMITTED site index. It describes the blocks that ship with the app, which are
# committed too, so it changes only when they do — and the Pages deploy job has no loft to measure extents
# with. `browser/build-site.mjs` copies it into _site; `tools/index_fresh_gate.sh` proves it still matches.
out="${1:-$here/browser/coverage.json}"

# WHERE THE BYTES ARE MEASURED — the SOURCE, not the built site.
#
# A manifest path like `stores/enschede.roads.store` is a URL relative to the site root, and it used to
# double as the place to read the file: `_site/stores/…`. But `_site` is a BUILD OUTPUT, a copy made by
# browser/build-site.mjs, so the index described whatever was last copied there rather than what is
# committed. Measured 2026-07-31: a freshly rebuilt block was installed in browser/stores and the
# regenerated index still carried the OLD sha, tiles and feature count, because _site held the previous
# copy.
#
# ⚠ AND tools/index_fresh_gate.sh COULD NOT SEE IT. The gate regenerates and diffs, so both sides read
# the same stale copy, agree, and the gate passes while claiming "the committed index matches the
# committed blocks" — the one thing it exists to prove. A check that reads a derived copy is not
# checking the source.
#
# Resolution order is therefore source first, `_site` last: browser/ holds the committed site blocks,
# blocks/ the release ones, and _site is kept only for blocks that exist NOWHERE ELSE — the split
# fixtures tools/cross_block_browser_gate.sh stages there.
roots="$here/browser|$here/blocks|$here/_site"
# THE VERSION IS A RELEASE NAME, NOT A MEASUREMENT — so regenerating an index must not rename the
# dataset. Everything else in this file is measured out of the blocks and changes only when they do;
# the version is chosen by whoever publishes them. Precedence: an explicit DATASET_VERSION, else the
# name the existing index already carries, else today's date for a first generation.
#
# Earned: three gates (map_render, cross_block_browser, cors_host) call this with NO argument, and the
# default output is the COMMITTED browser/coverage.json — so `make test-map` rewrote a committed file on
# every run, and the version it carried was simply whichever day a gate last happened to execute. That
# also made index_fresh_gate.sh compare the calendar: green on the day of the commit, red every day
# after. A publish now passes the tag it publishes under, so the index names its own release.
version="${DATASET_VERSION:-$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$out" 2>/dev/null)}"
version="${version:-$(date -u +v%Y-%m-%d)}"
[ -f "$manifest" ] || { echo "FAIL: no manifest at $manifest"; exit 1; }

extent() {  # $1 = store path, $2 = roads|base  → "mnla mnlo mxla mxlo tiles feats"
  "$loft" --native --lib "$here/lib" "$here/tools/store_extent.loft" "$1" "$2" 2>/dev/null \
    | grep -oP '^EXTENT \K.*'
}
# RELEASE_BASE turns the index into one a consumer can resolve with nothing but the tag: the urls become
# absolute release-asset URLs instead of paths relative to the site. Same extents, same hashes — only where
# the bytes live changes, which is exactly what the index is for.
block_json() {  # $1 = path relative to root, $2 = roads|base, $3 = per-region url base ("" = site-relative)
  local rel="$1" kind="$2" ubase="${3:-}" abs=""
  local r; local IFS='|'
  for r in $roots; do
    if [ -f "$r/$rel" ]; then abs="$r/$rel"; break; fi
    if [ -f "$r/$(basename "$rel")" ]; then abs="$r/$(basename "$rel")"; break; fi
  done
  unset IFS
  # A region can live beside the app (site-relative) or at an absolute base — a release, a bucket. Per
  # REGION, not per run: a small block ships with the site while a country block is published elsewhere,
  # and the index is the only thing that has to know.
  local url="$rel"
  [ -n "${RELEASE_BASE:-}" ] && url="$RELEASE_BASE/$(basename "$rel")"
  [ -n "$ubase" ] && url="$ubase/$(basename "$rel")"
  [ -f "$abs" ] || { echo "FAIL: manifest names a missing block: $rel" >&2; return 1; }
  local e; e="$(extent "$abs" "$kind")"
  [ -n "$e" ] || { echo "FAIL: could not read the extent of $rel" >&2; return 1; }
  set -- $e
  printf '{"url":"%s","bytes":%s,"sha256":"%s","tiles":%s,"features":%s,"bbox":{"mnla":%s,"mnlo":%s,"mxla":%s,"mxlo":%s}}' \
    "$url" "$(stat -c%s "$abs")" "$(sha256sum "$abs" | cut -d' ' -f1)" "$5" "$6" "$1" "$2" "$3" "$4"
}

echo "== building the top index from $(basename "$manifest") =="
regions=""; n=0
# The manifest is TOML but only ever a list of flat [[region]] tables, so it is read line by line rather
# than by pulling in a parser — and a key that is not understood is a hard error, not a silent skip.
id=""; name=""; roads=""; base=""; mode=""; ubase=""
flush() {
  [ -n "$id" ] || return 0
  # ⚠ A block written before a schema change does not read as "field missing" — it reads GARBAGE
  # (loft#700: store_load ignores the sidecar's schema hash and maps old records at the new stride).
  # An index is the app's list of what to load, so a stale-schema block must not get into one.
  # The SOURCE locations only — `_site` is a build artifact that build-site.mjs rewrites, and a stale
  # copy there says nothing about the block this index will describe.
  for sc in "$here/browser/$roads.dschema" "$here/blocks/$(basename "$roads" 2>/dev/null).dschema"; do
    if [ -f "$sc" ] && ! grep -q "barriers@" "$sc"; then
      echo "  FAIL: $id's block predates the barriers field — regenerate it (tools/build-blocks.sh); loft#700"
      exit 1
    fi
  done
  # A region with `url_base` lives in a release/bucket. The SITE index must not name it: the page would
  # resolve a block it cannot fetch (release assets send no CORS header), and the app would boot into a
  # map that never loads. Publishing sets RELEASE_INDEX=1 and takes them all.
  if [ -n "$ubase" ] && [ "${RELEASE_INDEX:-0}" != "1" ]; then
    echo "  $id: published at $ubase — not in the site index"
    id=""; name=""; roads=""; base=""; mode=""; ubase=""
    return 0
  fi
  # …and the mirror of it: a site-only region has a RELATIVE url, which a consumer resolving against the
  # release index would turn into a 404. Each index names only what it can actually serve.
  if [ -z "$ubase" ] && [ "${RELEASE_INDEX:-0}" = "1" ]; then
    echo "  $id: ships with the site — not in the release index"
    id=""; name=""; roads=""; base=""; mode=""; ubase=""
    return 0
  fi
  local rj bj
  rj="$(block_json "$roads" roads "$ubase")" || exit 1
  bj="$(block_json "$base" base "$ubase")" || exit 1
  local entry
  entry="$(printf '{"id":"%s","name":"%s","readMode":"%s","roads":%s,"base":%s}' "$id" "$name" "$mode" "$rj" "$bj")"
  if [ -n "$regions" ]; then regions="$regions,$entry"; else regions="$entry"; fi
  n=$((n + 1))
  echo "  $id: roads $(echo "$rj" | grep -oP '"tiles":\K[0-9]+') tiles · base $(echo "$bj" | grep -oP '"tiles":\K[0-9]+') tiles · read=$mode"
  id=""; name=""; roads=""; base=""; mode=""; ubase=""
}
while IFS= read -r line; do
  case "$line" in
    '[[region]]'*) flush ;;
    id*=*)         id="$(echo "$line"   | cut -d'"' -f2)" ;;
    name*=*)       name="$(echo "$line" | cut -d'"' -f2)" ;;
    roads*=*)      roads="$(echo "$line"| cut -d'"' -f2)" ;;
    base*=*)       base="$(echo "$line" | cut -d'"' -f2)" ;;
    read_mode*=*)  mode="$(echo "$line" | cut -d'"' -f2)" ;;
    url_base*=*)   ubase="$(echo "$line" | cut -d'"' -f2)" ;;
  esac
done < <(grep -v '^\s*#' "$manifest")
flush

[ "$n" -gt 0 ] || { echo "FAIL: the manifest produced no regions"; exit 1; }
mkdir -p "$(dirname "$out")"
printf '{"version":"%s","unit":"fixed-1e-7","blocks":[%s]}\n' "$version" "$regions" > "$out"
echo "  wrote $out ($(stat -c%s "$out") bytes, $n block(s), version $version)"
