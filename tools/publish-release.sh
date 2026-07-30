#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Publish the generated blocks as a GitHub RELEASE (PLAN-SCALE §7 R6).
#
# Blocks are output, not source: a country's roads block is ~322 MB and its base map larger still, so they
# are shipped as release assets rather than committed. A release is also the natural unit of a DATASET
# VERSION — one tag, one set of blocks, one index that names them with their sha256.
#
# THE ORDER IS THE POINT (R6): upload everything, verify each asset is really there and really
# range-readable, and only THEN publish the index that names them. The index is the single mutable
# pointer, so a half-uploaded release is never something a client can resolve into.
#
# ⚠ WHAT A RELEASE CANNOT DO, measured 2026-07-30 rather than assumed:
#   * release assets serve `Range` (206 + Content-Range) — a paged reader works against them;
#   * they send NO `Access-Control-Allow-Origin`, even when the request carries an `Origin`.
# So a BROWSER on another origin cannot read them: this channel serves downloads, the native server, and
# offline use. The browser path needs a CORS host (PLAN-SCALE D2 — R2/B2), or same-origin hosting for
# blocks small enough to sit beside the app. `raw.githubusercontent.com` does send `ACAO: *` and does
# serve ranges, but it serves REPO files and git's size limits make it useless for a country block.
#
#   tools/publish-release.sh [tag]        # default: data-v<UTC date>
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="${RELEASE_REPO:-jjstwerff/routing}"
tag="${1:-data-$(date -u +v%Y-%m-%d)}"
blocks="${BLOCKS_OUT:-$here/blocks}"
command -v gh >/dev/null || { echo "FAIL: gh not found"; exit 1; }
[ -d "$blocks" ] || { echo "FAIL: no blocks/ — run tools/build-blocks.sh first"; exit 1; }

assets=()
for f in "$blocks"/*.store "$blocks"/*.dschema; do [ -e "$f" ] && assets+=("$f"); done
[ ${#assets[@]} -gt 0 ] || { echo "FAIL: blocks/ holds no stores"; exit 1; }

echo "== R6 publish: $tag → $repo =="
total=0
for f in "${assets[@]}"; do
  sz=$(stat -c%s "$f"); total=$((total + sz))
  printf "  %-40s %10s\n" "$(basename "$f")" "$(du -h "$f" | cut -f1)"
  # 2 GB is the documented per-asset ceiling; a block that outgrows it must be split at generation, not
  # here, because the index has to name the pieces.
  [ "$sz" -lt 2147483648 ] || { echo "FAIL: $(basename "$f") exceeds the 2 GB per-asset limit"; exit 1; }
done
echo "  total $(numfmt --to=iec $total)"

if gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
  echo "  release $tag exists — uploading with --clobber"
else
  gh release create "$tag" -R "$repo" --title "Map data $tag" --notes \
"Generated map blocks for the routing app (PLAN-SCALE §7).

Each block is a loft store, readable directly — no codec. \`coverage.json\` names them with their
measured extents and sha256, and is what a client resolves against.

⚠ Release assets serve HTTP Range but send no CORS header, so a browser on another origin cannot read
them; this channel is for downloads, the native server and offline use." || exit 1
fi

gh release upload "$tag" -R "$repo" --clobber "${assets[@]}" || { echo "FAIL: upload"; exit 1; }

# VERIFY BEFORE THE INDEX POINTS ANYWHERE: every asset must exist at its published URL, report the size we
# uploaded, and answer a Range request. An asset that uploaded truncated passes a size check and fails a
# route, three weeks later, for someone else.
echo "== verify the published assets =="
fail=0
for f in "${assets[@]}"; do
  name="$(basename "$f")"
  url="https://github.com/$repo/releases/download/$tag/$name"
  hdr="$(curl -sIL -H 'Range: bytes=0-99' "$url" 2>/dev/null)"
  code="$(echo "$hdr" | grep -ciE '^HTTP/[0-9.]+ 206' || true)"
  cr="$(echo "$hdr" | grep -iE '^content-range' | tail -1 | grep -oP '/\K[0-9]+' || true)"
  local_sz="$(stat -c%s "$f")"
  if [ "$code" -lt 1 ]; then echo "  FAIL $name — no 206 (Range unsupported or asset missing)"; fail=1
  elif [ "${cr:-0}" != "$local_sz" ]; then echo "  FAIL $name — published $cr bytes, local $local_sz"; fail=1
  else printf "  ok   %-40s 206, %s bytes\n" "$name" "$cr"; fi
done
[ $fail -eq 0 ] || { echo "FAIL: not publishing an index over unverified assets"; exit 1; }

# The index LAST, and built against the release URLs so a consumer needs nothing but the tag.
echo "== index =="
RELEASE_INDEX=1 RELEASE_BASE="https://github.com/$repo/releases/download/$tag" \
  "$here/tools/build_index.sh" "$here/blocks/coverage.json" || exit 1
gh release upload "$tag" -R "$repo" --clobber "$here/blocks/coverage.json" || exit 1
echo "PASS — $tag published, assets verified, index uploaded last"
echo "  index: https://github.com/$repo/releases/download/$tag/coverage.json"
