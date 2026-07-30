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
"$here/tools/build_index.sh" "$work/coverage.json" >/dev/null || { echo "FAIL: could not regenerate the index"; exit 1; }

if ! diff -q "$committed" "$work/coverage.json" >/dev/null; then
  echo "  FAIL: browser/coverage.json is STALE — regenerating it produces something else:"
  diff <(python3 -m json.tool "$committed") <(python3 -m json.tool "$work/coverage.json") | head -20 | sed 's/^/    /'
  echo "  fix: tools/build_index.sh && git add browser/coverage.json"
  exit 1
fi

# Non-vacuity: an index describing nothing would match a regeneration of nothing.
blocks="$(grep -o '"id"' "$committed" | wc -l)"
[ "$blocks" -ge 1 ] || { echo "  FAIL: the index names no blocks"; exit 1; }
echo "  ✓ $blocks block(s), byte-identical to a fresh generation"
echo "PASS — the site index describes the blocks that ship with it"
