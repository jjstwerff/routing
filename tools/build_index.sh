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
#   tools/build_index.sh [out.json]        # default: _site/coverage.json
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
manifest="$here/data/coverage.toml"
# At the SITE ROOT, not inside stores/: the block URLs in the manifest are relative to the root, and a
# URL is resolved against the file that CONTAINS it. An index one directory down turns "stores/x.store"
# into "stores/stores/x.store" — every block 404s and the app boots into an empty map.
out="${1:-$here/_site/coverage.json}"
root="$here/_site"                      # where the block paths in the manifest are rooted
version="${DATASET_VERSION:-$(date -u +v%Y-%m-%d)}"
[ -f "$manifest" ] || { echo "FAIL: no manifest at $manifest"; exit 1; }

extent() {  # $1 = store path, $2 = roads|base  → "mnla mnlo mxla mxlo tiles feats"
  "$loft" --native --lib "$here/lib" "$here/tools/store_extent.loft" "$1" "$2" 2>/dev/null \
    | grep -oP '^EXTENT \K.*'
}
block_json() {  # $1 = path relative to root, $2 = roads|base
  local rel="$1" kind="$2" abs="$root/$1"
  [ -f "$abs" ] || { echo "FAIL: manifest names a missing block: $rel" >&2; return 1; }
  local e; e="$(extent "$abs" "$kind")"
  [ -n "$e" ] || { echo "FAIL: could not read the extent of $rel" >&2; return 1; }
  set -- $e
  printf '{"url":"%s","bytes":%s,"sha256":"%s","tiles":%s,"features":%s,"bbox":{"mnla":%s,"mnlo":%s,"mxla":%s,"mxlo":%s}}' \
    "$rel" "$(stat -c%s "$abs")" "$(sha256sum "$abs" | cut -d' ' -f1)" "$5" "$6" "$1" "$2" "$3" "$4"
}

echo "== building the top index from $(basename "$manifest") =="
regions=""; n=0
# The manifest is TOML but only ever a list of flat [[region]] tables, so it is read line by line rather
# than by pulling in a parser — and a key that is not understood is a hard error, not a silent skip.
id=""; name=""; roads=""; base=""; mode=""
flush() {
  [ -n "$id" ] || return 0
  local rj bj
  rj="$(block_json "$roads" roads)" || exit 1
  bj="$(block_json "$base" base)" || exit 1
  local entry
  entry="$(printf '{"id":"%s","name":"%s","readMode":"%s","roads":%s,"base":%s}' "$id" "$name" "$mode" "$rj" "$bj")"
  if [ -n "$regions" ]; then regions="$regions,$entry"; else regions="$entry"; fi
  n=$((n + 1))
  echo "  $id: roads $(echo "$rj" | grep -oP '"tiles":\K[0-9]+') tiles · base $(echo "$bj" | grep -oP '"tiles":\K[0-9]+') tiles · read=$mode"
  id=""; name=""; roads=""; base=""; mode=""
}
while IFS= read -r line; do
  case "$line" in
    '[[region]]'*) flush ;;
    id*=*)         id="$(echo "$line"   | cut -d'"' -f2)" ;;
    name*=*)       name="$(echo "$line" | cut -d'"' -f2)" ;;
    roads*=*)      roads="$(echo "$line"| cut -d'"' -f2)" ;;
    base*=*)       base="$(echo "$line" | cut -d'"' -f2)" ;;
    read_mode*=*)  mode="$(echo "$line" | cut -d'"' -f2)" ;;
  esac
done < <(grep -v '^\s*#' "$manifest")
flush

[ "$n" -gt 0 ] || { echo "FAIL: the manifest produced no regions"; exit 1; }
mkdir -p "$(dirname "$out")"
printf '{"version":"%s","unit":"fixed-1e-7","blocks":[%s]}\n' "$version" "$regions" > "$out"
echo "  wrote $out ($(stat -c%s "$out") bytes, $n block(s), version $version)"
