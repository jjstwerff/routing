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

# A store with no geographic extent — the name index. Same locate-and-hash treatment as `block_json`,
# without the `store_extent` call, which only understands map layers.
names_json() {  # $1 = path relative to root
  local rel="$1" abs=""
  # Same hosting rule as `block_json`: a RELEASE index must name it absolutely, or a consumer resolving
  # against the tag turns "stores/nl.names.store" into a 404. Missed on the first pass because the name
  # store is the one store with no extent, so it took a different code path.
  local r; local IFS='|'
  for r in $roots; do
    if [ -f "$r/$rel" ]; then abs="$r/$rel"; break; fi
    if [ -f "$r/$(basename "$rel")" ]; then abs="$r/$(basename "$rel")"; break; fi
  done
  unset IFS
  [ -f "$abs" ] || { echo "FAIL: manifest names a missing name store: $rel" >&2; return 1; }
  local url="$rel"
  [ -n "${RELEASE_BASE:-}" ] && url="$RELEASE_BASE/$(basename "$rel")"
  printf '{"url":"%s","bytes":%s,"sha256":"%s"}' \
    "$url" "$(stat -c%s "$abs")" "$(sha256sum "$abs" | cut -d' ' -f1)"
}

echo "== building the top index from $(basename "$manifest") =="
regions=""; n=0
# The manifest is TOML but only ever a list of flat [[region]] tables, so it is read line by line rather
# than by pulling in a parser — and a key that is not understood is a hard error, not a silent skip.
id=""; name=""; roads=""; base=""; names=""; mode=""; ubase=""; bubase=""; bcors=""
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
    id=""; name=""; roads=""; base=""; names=""; mode=""; ubase=""; bubase=""; bcors=""
    return 0
  fi
  # …and the mirror of it: each index names only what it can actually serve.
  #
  # ⚠ THE TEST IS "IS IT BEING PUBLISHED", NOT "DOES IT HAVE A url_base". It used to be the latter, which
  # meant the same thing while hosting was per REGION — a region was either site-local or released. Since
  # NL split its stores across both (roads beside the app, base map on the release, PLAN-SCALE N3) no
  # region carries a plain `url_base` any more, and that rule excluded EVERY region: the release index
  # came out empty, and `publish-release.sh` refused to publish it. Which is the ordering working — an
  # empty index would have been a release nobody could resolve.
  #
  # A block is being published exactly when it sits in the PUBLISH ROOT — `blocks/`, the generated-output
  # directory `publish-release.sh` uploads. Enschede's blocks are committed under `browser/stores/` and
  # ship with the app, so they are correctly absent from a release index.
  #
  # `PUBLISH_ROOT` overrides that directory for a harness that publishes somewhere else. `cors_host_gate`
  # is the case: it serves a committed block from a second local ORIGIN, which is a real publication with
  # no `blocks/` involved — and without the override the test read as "Enschede ships with the site", the
  # index came out empty, and the gate failed on every checkout (it had, since this test replaced the
  # `url_base` one). The rule is unchanged; what was hard-coded is the place it looks.
  if [ "${RELEASE_INDEX:-0}" = "1" ] && [ ! -f "${PUBLISH_ROOT:-$here/blocks}/$(basename "$roads")" ]; then
    echo "  $id: ships with the site — not in the release index"
    id=""; name=""; roads=""; base=""; names=""; mode=""; ubase=""; bubase=""; bcors=""
    return 0
  fi
  local rj bj
  rj="$(block_json "$roads" roads "$ubase")" || exit 1
  # HOSTING IS PER STORE, not per region. The Netherlands is the case that forces it: its ROADS (502 MB
  # over four regions) fit beside the app on Pages, and its BASE MAP (2.75 GB) does not — so one region
  # has one store the site can serve and one it cannot. `base_url_base` says where the base lives when
  # that is somewhere else.
  #
  # ⚠ WHETHER THE SITE INDEX MAY NAME IT DEPENDS ON WHAT THAT HOST SENDS, WHICH IS `base_cors`.
  #   * a GitHub RELEASE serves `Range` and NO `Access-Control-Allow-Origin` — a page on the app's origin
  #     cannot read it, so naming the URL would hand the app something it can only fail on. `base: null`
  #     is the honest state and one the app handles (store-app.mjs: LAYOUT becomes "").
  #   * a second Pages SITE sends `access-control-allow-origin: *` with a real 206 (measured 2026-08-01),
  #     so the browser CAN read it and the index must name it — suppressing it there would leave the map
  #     blank for no reason, which is the bug §6f exists to fix.
  # It defaults to false, so a manifest that says nothing keeps the release behaviour.
  bj=null
  if [ -n "$bubase" ] && [ "${RELEASE_INDEX:-0}" != "1" ] && [ "${bcors:-false}" != "true" ]; then
    echo "  $id: base map published at $bubase (no CORS) — the site index names roads only"
  elif [ -n "$base" ]; then
    bj="$(block_json "$base" base "${bubase:-$ubase}")" || exit 1
  fi
  # PLAN-RESTORE R4 — the searchable names. A store of its own, always site-relative: 34.4 MB for the
  # whole country against a 950 MB budget, and a search that needs a network request is the thing R4
  # exists to remove. No extent: it is not a map layer, so there is no bbox to measure — just where the
  # bytes are and whether they are the ones this index describes.
  local nj=null
  if [ -n "$names" ]; then nj="$(names_json "$names")" || exit 1; fi
  local entry
  entry="$(printf '{"id":"%s","name":"%s","readMode":"%s","roads":%s,"base":%s,"names":%s}' "$id" "$name" "$mode" "$rj" "$bj" "$nj")"
  if [ -n "$regions" ]; then regions="$regions,$entry"; else regions="$entry"; fi
  n=$((n + 1))
  echo "  $id: roads $(echo "$rj" | grep -oP '"tiles":\K[0-9]+') tiles · base $(echo "$bj" | grep -oP '"tiles":\K[0-9]+' || echo none) tiles · read=$mode"
  id=""; name=""; roads=""; base=""; names=""; mode=""; ubase=""; bubase=""; bcors=""
}
while IFS= read -r line; do
  case "$line" in
    '[[region]]'*) flush ;;
    id*=*)         id="$(echo "$line"   | cut -d'"' -f2)" ;;
    # ⚠ `names` BEFORE `name` — see the ordering note below. `name*=*` matches `names = "..."` too, and
    # putting it first silently read the name store as the region's display name and left `names` unset,
    # so every block came out `names=NONE` with no error anywhere.
    names*=*)      names="$(echo "$line" | cut -d'"' -f2)" ;;
    name*=*)       name="$(echo "$line" | cut -d'"' -f2)" ;;
    roads*=*)      roads="$(echo "$line"| cut -d'"' -f2)" ;;
    # ⚠ ORDER MATTERS — these are globs, first match wins. `base_url_base` must be tested BEFORE `base`,
    # or `base*=*` swallows it and the key silently reads as the base STORE path. Same reason
    # `read_mode` sits above nothing that could shadow it. Adding a key here means checking what
    # already-listed prefix could match it.
    # ⚠ BEFORE `base_url_base`, which would otherwise swallow it — same glob-ordering rule as the
    # `names`/`name` pair above. `base_cors` is a BOOLEAN, so it is read off the bare token, not a
    # quoted value.
    base_cors*=*)  bcors="$(echo "$line" | tr -d ' "' | cut -d= -f2)" ;;
    base_url_base*=*) bubase="$(echo "$line" | cut -d'"' -f2)" ;;
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
