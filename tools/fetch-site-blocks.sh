#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Fetch the generated blocks the SITE INDEX names relatively, so a Pages build can serve them.
#
# PLAN-SCALE N3 puts the NL roads beside the app (497 MB, under the ~1 GB Pages cap). They cannot be
# committed: nl-east.roads.store is 263.9 MB and GitHub hard-rejects any file over 100 MB. So the deploy
# has to fetch them, and the only honest source of "which files, and are they the right ones" is the
# index itself — it already records a byte count and a sha256 per block.
#
# ⚠ IT VERIFIES, AND FAILS LOUDLY. A missing or truncated block does not degrade gracefully: the index
# still names it, the app still resolves to it, and every match in that region returns NO ROUTE from a
# 404 that nothing surfaces. That exact failure has already happened once locally (build-site.mjs
# refusing to copy blocks over 64 MB), and it looked like a broken router rather than a missing file.
# Shipping it would be worse, so a bad fetch stops the build.
#
#   tools/fetch-site-blocks.sh [release-tag]
#     release-tag  defaults to `data-<version>` from the index (e.g. data-v2026-07-30)
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
idx="$here/browser/coverage.json"
[ -f "$idx" ] || { echo "FAIL: no browser/coverage.json — nothing describes what the site must serve"; exit 1; }

version="$(python3 -c "import json;print(json.load(open('$idx')).get('version',''))")"
tag="${1:-data-$version}"
[ -n "$version" ] || { echo "FAIL: the index states no version, so no release tag can be derived"; exit 1; }
base="https://github.com/jjstwerff/routing/releases/download/$tag"
mkdir -p "$here/blocks"

# Every store the index names with a RELATIVE url is one this origin must serve. An absolute url is
# someone else's problem by construction (the NL base map, which stays on the release because 2.87 GB
# does not fit the cap).
mapfile -t rows < <(python3 - "$idx" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for b in d.get("blocks", []):
    for st in (b.get("roads"), b.get("base"), b.get("names")):
        if not st or not st.get("url"): continue
        if "://" in st["url"]: continue
        print(f'{st["url"].rsplit("/",1)[-1]}\t{st.get("bytes",0)}\t{st.get("sha256","")}')
PY
)

echo "== fetching the blocks the index names, from $tag =="
rc=0; got=0; had=0
for row in "${rows[@]}"; do
  IFS=$'\t' read -r name want_bytes want_sha <<<"$row"
  # Committed blocks (the small Enschede one) live in browser/stores and need no fetch.
  [ -f "$here/browser/stores/$name" ] && { echo "  $name — committed beside the app"; continue; }
  dst="$here/blocks/$name"
  if [ -f "$dst" ] && [ "$(stat -c%s "$dst")" = "$want_bytes" ] \
     && [ "$(sha256sum "$dst" | cut -d' ' -f1)" = "$want_sha" ]; then
    echo "  $name — already present and matches the index"; had=$((had + 1)); continue
  fi
  echo "  $name — fetching $(python3 -c "print(f'{$want_bytes/1e6:.1f}')") MB"
  # To a sidecar, then move: a half-written block that survives to the next run is the cache-destroying
  # shape build-blocks.sh already learned the hard way.
  if ! curl -fsSL --retry 3 -o "$dst.part" "$base/$name"; then
    echo "  FAIL: could not download $base/$name"; rm -f "$dst.part"; rc=1; continue
  fi
  have_bytes="$(stat -c%s "$dst.part")"; have_sha="$(sha256sum "$dst.part" | cut -d' ' -f1)"
  if [ "$have_bytes" != "$want_bytes" ] || [ "$have_sha" != "$want_sha" ]; then
    echo "  FAIL: $name does not match the index"
    echo "        bytes want $want_bytes have $have_bytes"
    echo "        sha256 want $want_sha"
    echo "               have $have_sha"
    echo "        The release asset is not the block this index describes — most likely the blocks were"
    echo "        regenerated without re-uploading them, or uploaded without rebuilding the index."
    rm -f "$dst.part"; rc=1; continue
  fi
  mv -f "$dst.part" "$dst"; got=$((got + 1))
done

[ "$rc" -eq 0 ] || { echo "FAIL — the site cannot be built without every block its index names"; exit 1; }
echo "  $got fetched, $had already current"
