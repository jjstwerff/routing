#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# WHICH REGIONS FEED WHICH DERIVED BLOCK — `build-derived.sh`'s `derive_from` scoping, asserted.
#
# WHY IT NEEDS A GATE. The selection is only ever exercised by a full derived build, which is an hour of
# CPU, so in practice it would be exercised by NOBODY until a country came out wrong — and the failure is
# the quiet kind this repo keeps paying for: a middle-zoom block built from the wrong country's regions
# still persists, still publishes, and still draws a map. It just draws the wrong ground.
#
# It runs entirely on `DRY_RUN=1` against a synthetic manifest and touched placeholder stores, so it costs
# a second and needs no data. What it asserts is the SELECTION, which is the whole of the logic; the build
# itself is `build_overview.loft`'s business and `overview_gate` covers that.
#
# The case worth keeping is the third one: a refresh of ONE country must still rebuild the OVERVIEW,
# because the overview reads every country's regions. Filtering on `derive_from` alone gets that wrong,
# and the resulting overview would describe the previous snapshot of the country that was just refreshed.
#
#   tools/derived_scope_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="${TMPDIR:-/tmp}/derived-scope-$$"
mkdir -p "$work/blocks"
trap 'rm -rf "$work"' EXIT

# Placeholders: `build-derived.sh` checks that each source's two stores EXIST before naming them, and
# DRY_RUN stops before anything reads one. Touched, named, and inside a directory we just made.
for r in nl-west nl-east belgium luxembourg; do
  : >"$work/blocks/$r.roads.store"; : >"$work/blocks/$r.base.store"
done

cat >"$work/m.toml" <<'TOML'
[[region]]
id = "overview"
base = "stores/overview.base.store"
build_zmax = 10
build_min_tier = 2

[[region]]
id = "nl-mid"
derive_from = "netherlands"
base = "stores/nl-mid.base.store"
build_zmax = 12
build_min_tier = 1

[[region]]
id = "be-mid"
derive_from = "belgium"
base = "stores/be-mid.base.store"
build_zmax = 12
build_min_tier = 1

[[region]]
id = "nl-west"
cut_from = "netherlands"
roads = "stores/nl-west.roads.store"

[[region]]
id = "nl-east"
cut_from = "netherlands"
roads = "stores/nl-east.roads.store"

[[region]]
id = "belgium"
roads = "stores/belgium.roads.store"

[[region]]
id = "luxembourg"
roads = "stores/luxembourg.roads.store"
TOML

plan() {   # $1 = country filter ("" = all) → "block:sources" per line, blocks that would BUILD only
  DRY_RUN=1 COVERAGE_MANIFEST="$work/m.toml" BLOCKS_OUT="$work/blocks" \
    "$here/tools/build-derived.sh" $1 2>&1 \
    | sed -n 's/^########## \([a-z-]*\) — zmax [0-9]*, min tier [0-9]*, from: \(.*\) ##########$/\1:\2/p'
}

fails=0
check() {  # $1 = label, $2 = filter, $3 = expected plan (newline-separated)
  got="$(plan "$2")"
  if [ "$got" = "$3" ]; then
    printf '  ✔ %s\n' "$1"
  else
    printf '  ✘ %s\n     expected: %s\n     got:      %s\n' "$1" "$(echo "$3" | tr '\n' '|')" "$(echo "$got" | tr '\n' '|')"
    fails=$((fails + 1))
  fi
}

echo "== derived-block source scoping =="

check "no filter: every block, each from its own scope" "" \
"overview:nl-west nl-east belgium luxembourg
nl-mid:nl-west nl-east
be-mid:belgium"

# A country whose regions are named by `cut_from`, and one that IS its own region (Belgium before @51
# phase C cuts it). Both must resolve, or `be-mid` breaks the day Belgium is split.
check "derive_from matches a cut_from group" "netherlands" \
"overview:nl-west nl-east belgium luxembourg
nl-mid:nl-west nl-east"

check "derive_from matches a region's own id" "belgium" \
"overview:nl-west nl-east belgium luxembourg
be-mid:belgium"

# THE ONE THIS GATE IS FOR. Luxembourg feeds no middle-zoom block in this manifest, but it IS in the
# overview — so a Luxembourg refresh must still rebuild the overview and nothing else.
check "a refresh of one country still rebuilds the overview" "luxembourg" \
"overview:nl-west nl-east belgium luxembourg"

# A filter naming nothing must FAIL rather than quietly build zero blocks and report success.
if DRY_RUN=1 COVERAGE_MANIFEST="$work/m.toml" BLOCKS_OUT="$work/blocks" \
   "$here/tools/build-derived.sh" france >/dev/null 2>&1; then
  echo "  ✘ an unknown country was accepted — a typo would build nothing and look fine"
  fails=$((fails + 1))
else
  echo "  ✔ an unknown country fails instead of building nothing"
fi

# And a derive_from pointing at no source is the same class of typo, one level down.
sed 's/derive_from = "belgium"/derive_from = "belgique"/' "$work/m.toml" >"$work/typo.toml"
if DRY_RUN=1 COVERAGE_MANIFEST="$work/typo.toml" BLOCKS_OUT="$work/blocks" \
   "$here/tools/build-derived.sh" >/dev/null 2>&1; then
  echo "  ✘ derive_from naming no region was accepted — that block would persist as an empty map"
  fails=$((fails + 1))
else
  echo "  ✔ derive_from naming no region fails"
fi

echo
[ "$fails" = 0 ] || { echo "FAIL — $fails scoping case(s) wrong."; exit 1; }
echo "PASS — every derived block reads exactly the regions it declares."
exit 0
