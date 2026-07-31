#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-SCALE S7 — the committed site index still describes the committed blocks.
#
# `browser/coverage.json` is the index the app resolves against, and it is COMMITTED: it measures extents,
# sizes and sha256 out of the stores, which needs loft, and the Pages deploy job has none. That makes it
# the one generated artifact in the tree that can silently rot — regenerate a block, forget the index, and
# the app resolves against stale extents or a hash that no longer matches.
#
# The failure it guards is not subtle and it has already happened once: between S7 landing and the deploy
# copying this file, the published site had NO index at all and the app booted to "no coverage index — the
# app has no data to show". A wrong index is the same blank map, only harder to see.
#
# So: regenerate into a temp file and require it byte-identical. Cheap, exact, and it names the fix.
#
#   tools/index_fresh_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
committed="$here/browser/coverage.json"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
[ -f "$committed" ] || { echo "FAIL: no browser/coverage.json — the app would boot with no data (run tools/build_index.sh)"; exit 1; }

echo "== S7: the committed index matches the committed blocks =="

# PIN THE VERSION — it is a RELEASE NAME, not a property of the blocks.
#
# `build_index.sh` defaults `version` to today's UTC date, so an unpinned regeneration differs from the
# committed file on every day EXCEPT the one it was written on. That made this gate fail on the CALENDAR:
# green until the UTC date rolled past the commit, then red every day after, reporting "STALE" about an
# index that describes its blocks perfectly. A gate that cries wolf on a clock is worse than no gate —
# it teaches you to skip the run that finally means it.
#
# Pinned, the diff is exactly what can rot: extents, tile/feature counts, sizes and sha256.
pin="$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$committed")"
[ -n "$pin" ] || { echo "  FAIL: browser/coverage.json names no version"; exit 1; }
DATASET_VERSION="$pin" "$here/tools/build_index.sh" "$work/coverage.json" >/dev/null \
  || { echo "FAIL: could not regenerate the index"; exit 1; }

if ! diff -q "$committed" "$work/coverage.json" >/dev/null; then
  echo "  FAIL: browser/coverage.json is STALE — regenerating it produces something else:"
  diff <(python3 -m json.tool "$committed") <(python3 -m json.tool "$work/coverage.json") | head -20 | sed 's/^/    /'
  echo "  fix: DATASET_VERSION=$pin tools/build_index.sh browser/coverage.json && git add browser/coverage.json"
  echo "       (publishing NEW data instead? then choose the new version deliberately and update data/coverage.toml's url_base with it)"
  exit 1
fi

# Pinning costs one real signal, so take it back: a new data release whose index version was never
# updated. The release tag in data/coverage.toml carries the same name the index should.
tags="$(sed -n 's|.*releases/download/data-\(v[0-9][0-9-]*\).*|\1|p' "$here/data/coverage.toml" | sort -u)"
if [ -n "$tags" ]; then
  [ "$(echo "$tags" | wc -l)" -eq 1 ] \
    || { echo "  FAIL: data/coverage.toml names more than one release tag:"; echo "$tags" | sed 's/^/    /'; exit 1; }
  [ "$tags" = "$pin" ] \
    || { echo "  FAIL: the index says version $pin but data/coverage.toml publishes from data-$tags"; exit 1; }
  echo "  ✓ version $pin matches the release the blocks are published from"
fi

# Non-vacuity: an index describing nothing would match a regeneration of nothing.
blocks="$(grep -o '"id"' "$committed" | wc -l)"
[ "$blocks" -ge 1 ] || { echo "  FAIL: the index names no blocks"; exit 1; }
echo "  ✓ $blocks block(s), byte-identical to a fresh generation"
echo "PASS — the site index describes the blocks that ship with it"
