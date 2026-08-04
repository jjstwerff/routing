#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-SCALE C2 — within one index, no two road blocks may hold the same cell (DISJOINT), and a set of
# regions still adds up to the block it was cut from (COMPLETE).
#
# ⚠ THE TWO HALVES DO NOT IMPLY EACH OTHER, and assuming they did hid a real defect. A banded Belgium
# build passed the disjointness half — 0 shared cells over 10 373 — while four ways were missing, because
# the cell holding them was PRESENT and merely under-filled. A cell-SET comparison cannot see that; only
# comparing the way count per cell can. `tools/cell_diff.loft` is the second half and reports MISSING (a
# cell no part holds) / SHORT (a cell every part holds, with fewer ways) / OVER / outside-the-reference.
#
# WHY IT IS A GATE. A corridor names every block whose extent it touches and reads the same cell window
# from each, so a cell held by two blocks it can name together delivers its roads TWICE. That is not a
# slower match, it is a different one — it survived once only because `build_graph` dedups nodes by coordinate (Enschede listed
# inside the Netherlands turned 7,138 ways into 9,438 for an identical route, which is luck, not design).
#
# The index cannot check this: it stores extents, and extents legitimately overlap because a feature is
# keyed by its first vertex and never clipped. Only the cell sets settle it, and only the blocks
# themselves have those.
#
# ⚠ THE INVARIANT IS PER RESOLVABLE SET, not per manifest. A region is reachable from exactly one index —
# the site index (blocks that ship beside the app) or a release index (blocks published under a
# `url_base`) — and a corridor can only ever name blocks from the index it resolved against. Two blocks in
# DIFFERENT indexes can never be read together, so they may overlap: the Enschede block that ships with
# the app sits inside the Netherlands regions and shares 84 cells with nl-east, which is correct and
# harmless. The first version of this gate compared everything to everything and failed on exactly that —
# a real ambiguity in the model, and the reason the rule is now stated this precisely.
#
# It matters most for the step that has not happened yet. Blocks cut from ONE extract on cell boundaries
# are disjoint by construction; blocks taken from per-country Geofabrik extracts are not, because those
# deliberately include cross-border data. Western Europe is many files, and this is the check that says
# which kind they are — before a continent is generated on top of the wrong one.
#
#   tools/block_overlap_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
manifest="$here/data/coverage.toml"
[ -f "$manifest" ] || { echo "SKIP: no manifest"; exit 2; }

# Read the manifest into (url_base, roads-path) pairs — the url_base IS the index a region belongs to —
# resolving each block wherever it actually lives: beside the app (committed, small) or in blocks/
# (generated, published).
declare -A group_paths
declare -A cut_paths        # cut_from source id -> the parts cut from it
missing=()
ubase=""; roads=""; cfrom=""
flush() {
  [ -n "$roads" ] || return 0
  local key="${ubase:-__site__}" found=""
  for cand in "$here/_site/$roads" "$here/browser/$roads" "$here/blocks/$(basename "$roads")"; do
    [ -f "$cand" ] && { found="$cand"; break; }
  done
  if [ -n "$found" ]; then
    # ⚠ A STAGED REGION IS IN NO INDEX, so it is not part of this invariant — which is "within one index",
    # and a block nothing resolves to cannot be read beside anything. Grouping it with the site index made
    # this gate fail the moment Belgium was added as a derivation source, and failing was CORRECT for the
    # question it was asking; the question was just the wrong one for a block that does not ship.
    #
    # It is NOT dropped, though. The overlap it has with the live index is real and is exactly what @51
    # phase C must trim, so it moves to its own section below that REPORTS without failing. Silently
    # excluding it would delete the only measurement of the work that is outstanding.
    if [ "${stg:-false}" = "true" ]; then staged_paths="${staged_paths:-} $found"
    else
      group_paths[$key]="${group_paths[$key]:-} $found"
      [ -n "$cfrom" ] && cut_paths[$cfrom]="${cut_paths[$cfrom]:-} $found"
    fi
  else missing+=("$roads"); fi
  ubase=""; roads=""; cfrom=""; stg=""
}
while IFS= read -r line; do
  case "$line" in
    '[[region]]'*) flush ;;
    *roads*=*)     roads="$(echo "$line" | cut -d'"' -f2)" ;;
    # ⚠ `base_url_base` says where the BASE MAP lives and must be IGNORED here — this gate is about road
    # blocks, and hosting is per store since NL split (its roads ship on Pages, its base map does not).
    # Left to the glob below it would have matched `*url_base*`, filed both NL halves under the release,
    # and reported "the site index: 1 block" — a pass by not looking.
    *base_url_base*=*) ;;
    *url_base*=*)  ubase="$(echo "$line" | cut -d'"' -f2)" ;;
    cut_from*=*)   cfrom="$(echo "$line" | cut -d'"' -f2)" ;;
    staged*=*)     stg="$(echo "$line" | tr -d ' "' | cut -d= -f2)" ;;
  esac
done < <(grep -v '^\s*#' "$manifest")
flush

echo "== C2: within one index, no cell is held by two road blocks =="
[ ${#missing[@]} -eq 0 ] || printf '  (not present locally, skipped: %s)\n' "${missing[*]}"

rc=0; checked=0
for key in "${!group_paths[@]}"; do
  read -r -a paths <<< "${group_paths[$key]}"
  label="$key"; [ "$key" = "__site__" ] && label="the site index"
  if [ ${#paths[@]} -lt 2 ]; then
    echo "  $label: ${#paths[@]} block — nothing to compare"
    continue
  fi
  checked=$((checked + 1))
  echo "  $label:"
  out="$("$loft" --native --lib "$here/lib" "$here/tools/block_overlap.loft" "${paths[@]}" 2>&1)" \
    || { echo "$out"; echo "FAIL — the overlap probe did not run"; exit 1; }
  echo "$out" | grep -E '^  block |^#O' | sed 's/^/    /'
  echo "$out" | grep -q '^#O ALL PASS' || rc=1
done

# --- STAGED blocks: how much would have to be trimmed before they could ship? --------------------------
#
# Reported, never failed. A staged block is in no index, so it breaks no invariant today — but the number
# below IS the outstanding work (@51 phase C), and it is the only place it gets measured. When phase C
# trims these and the flag comes off, they join C2 above and this section goes quiet on its own.
if [ -n "${staged_paths:-}" ]; then
  echo "== staged blocks: not in any index, so not part of C2 — this is the TRIM LIST =="
  read -r -a live <<< "${group_paths[__site__]:-}"
  for sp in ${staged_paths}; do
    if [ ${#live[@]} -eq 0 ]; then echo "  $(basename "$sp"): nothing live to compare against"; continue; fi
    sout="$("$loft" --native --lib "$here/lib" "$here/tools/block_overlap.loft" "${live[@]}" "$sp" 2>&1)"
    shared="$(echo "$sout" | grep -oP 'PARTIALLY overlap: \K[0-9]+' | paste -sd+ | bc 2>/dev/null || echo 0)"
    if [ "${shared:-0}" = 0 ]; then
      echo "  ✔ $(basename "$sp"): disjoint from the live index already — it could ship as roads today"
    else
      echo "  · $(basename "$sp"): ${shared} cells shared with the live index — phase C trims these"
    fi
  done
fi

# --- the COMPLETENESS half: do the regions still add up to the block they were cut from? ---------------
# Only runs where a `cut_from` source is present locally. It is a generated artifact and deliberately not
# committed (a country block is hundreds of MB), so on a fresh clone this reports SKIP rather than passing
# by not looking — the distinction the disjointness half already makes for absent blocks.
echo "== C2b: the regions still add up to the block they were cut from =="
complete_checked=0
for srcid in "${!cut_paths[@]}"; do
  ref="$here/blocks/$srcid.roads.store"
  read -r -a parts <<< "${cut_paths[$srcid]}"
  if [ ! -f "$ref" ]; then
    echo "  $srcid: source block not present locally — SKIP (${#parts[@]} part(s) unchecked)"
    continue
  fi
  complete_checked=$((complete_checked + 1))
  # ⚠ EVERY BLOCK IN THE INDEX IS A PART, not only the ones cut from this source — because after a BORDER
  # TRIM a cell that leaves the Netherlands has not vanished, it has MOVED. @51 phase C gave 200 cells to
  # Belgium (it held more of each), and against the `cut_from` set alone those read as MISSING and the
  # gate failed on a dataset that conserves perfectly. Conservation is a property of the INDEX, not of one
  # country's cut, and it stopped being the same thing the moment coverage crossed a border.
  read -r -a allparts <<< "${group_paths[__site__]:-}"
  for extra in "${allparts[@]}"; do
    case " ${parts[*]} " in *" $extra "*) ;; *) parts+=("$extra") ;; esac
  done
  echo "  $srcid -> ${#parts[@]} part(s) (every roads block in the index):"
  cout="$("$loft" --native --lib "$here/lib" "$here/tools/cell_diff.loft" "$ref" "${parts[@]}" 2>&1)" \
    || { echo "$cout"; echo "FAIL — the completeness probe did not run"; exit 1; }
  # MISSING and SHORT are still hard failures: a source cell held by nobody, or held with FEWER ways than
  # the source, is data lost. OVER is expected and reported — a trimmed cell is held by the neighbour that
  # held MORE of it, which is the rule the trim applied and therefore its fingerprint.
  miss="$(echo "$cout" | grep -oP '^#C FAIL — \K[0-9]+' || echo 0)"
  shrt="$(echo "$cout" | grep -oP 'SHORT \(\K[0-9]+' || echo 0)"
  over="$(echo "$cout" | grep -oP '; \K[0-9]+(?= cell\(s\) OVER)' || echo 0)"
  if echo "$cout" | grep -q '^#C ALL PASS'; then
    echo "$cout" | grep -E '^#C ALL' | sed 's/^/    /'
  elif [ "${miss:-0}" = 0 ] && [ "${shrt:-0}" = 0 ]; then
    echo "    every cell of $srcid is held, none with fewer ways — ${over:-0} reassigned to a neighbour by the border trim"
  else
    echo "$cout" | grep -E '^#C' | head -12 | sed 's/^/    /'
    echo "    MISSING=${miss:-?} SHORT=${shrt:-?} — a cell held by nobody, or with fewer ways than the source, is data LOST"
    rc=1
  fi
done

# …and prove the check can still FAIL, on every run. Since nesting became an allowed outcome (a city block
# inside a country block shares all its cells by design), "no partial overlap" is a verdict this gate can
# reach by not looking hard enough — so it manufactures a pair it MUST reject. Two splits of the same
# block at DIFFERENT longitudes: each half holds cells the other lacks, plus a shared band between the
# cuts. That is the real defect's exact shape, built from data already in the repo.
src="$here/browser/stores/enschede.roads.store"
if [ -f "$src" ]; then
  t="$(mktemp -d)"
  "$loft" --native --lib "$here/lib" "$here/tools/split_block.loft" "$src" "$t/a_w" "$t/a_e" 6.85 >/dev/null 2>&1
  "$loft" --native --lib "$here/lib" "$here/tools/split_block.loft" "$src" "$t/b_w" "$t/b_e" 6.92 >/dev/null 2>&1
  self="$("$loft" --native --lib "$here/lib" "$here/tools/block_overlap.loft" "$t/a_e" "$t/b_w" 2>&1)"
  rm -rf "$t"
  if echo "$self" | grep -q '^#O FAIL — blocks 0 and 1 PARTIALLY overlap'; then
    echo "  self-check: a manufactured partial overlap IS rejected ($(echo "$self" | grep -oP 'PARTIALLY overlap: \K[0-9]+') shared cells)"
  else
    echo "FAIL — the gate no longer detects a partial overlap it was handed on purpose:"
    echo "$self" | grep -E '^#O' | sed 's/^/       /'
    exit 1
  fi

  # --- THE CEILING, and it is only a claim until something runs past it -------------------------------
  #
  # `block_overlap.loft` tracked cell owners as ONE BIT PER BLOCK and refused an index over 62. Western
  # Europe projects to 34–68 road blocks (PLAN-SCALE §6e), so the cap would have bound exactly where it
  # matters, and only once a continent was being generated on top of it. The mask became an owner LIST in
  # 8fe43a7 — which removed the ceiling in the code and left it UNMEASURED: nothing in the tree ever handed
  # the checker more than six blocks, so "no ceiling" was a comment, not a result.
  #
  # ⚠ IT ASSERTS BOTH HALVES, because the cheap version of this test passes for the wrong reason. Running
  # 70 blocks and seeing ALL PASS proves only that nothing capped; a checker that had quietly stopped
  # comparing would say exactly the same thing. So the same 70 blocks are handed a manufactured PARTIAL
  # overlap too, and the run must still reject it — detection at scale, not just survival at scale.
  #
  # The 70 are hardlinks of one committed block, so the disk cost is zero and every pair is a nesting
  # (identical cell sets), which is the allowed outcome — leaving the injected pair as the only defect.
  t4="$(mktemp -d)"
  nblk=70
  for c in $(seq 1 "$nblk"); do
    ln "$src" "$t4/n$c.roads.store" 2>/dev/null || cp "$src" "$t4/n$c.roads.store"
    [ -f "$src.dschema" ] && { ln "$src.dschema" "$t4/n$c.roads.store.dschema" 2>/dev/null || cp "$src.dschema" "$t4/n$c.roads.store.dschema"; }
  done
  clean="$("$loft" --native --lib "$here/lib" "$here/tools/block_overlap.loft" "$t4"/n*.roads.store 2>&1)"
  "$loft" --native --lib "$here/lib" "$here/tools/split_block.loft" "$src" "$t4/c_w" "$t4/c_e" 6.85 >/dev/null 2>&1
  "$loft" --native --lib "$here/lib" "$here/tools/split_block.loft" "$src" "$t4/d_w" "$t4/d_e" 6.92 >/dev/null 2>&1
  dirty="$("$loft" --native --lib "$here/lib" "$here/tools/block_overlap.loft" "$t4"/n*.roads.store "$t4/c_e" "$t4/d_w" 2>&1)"
  rm -rf "$t4"
  if echo "$clean" | grep -q "^#O ALL PASS — $nblk blocks"; then
    echo "  self-check: $nblk blocks compared with no ceiling ($(echo "$clean" | grep -oP 'blocks, \K[0-9]+') cells, $(echo "$clean" | grep -oP '\K[0-9]+(?= nested)') pairs)"
  else
    echo "FAIL — the checker did not get through $nblk blocks; the 62-block ceiling is back:"
    echo "$clean" | grep -E '^#O' | sed 's/^/       /'
    exit 1
  fi
  if echo "$dirty" | grep -q 'PARTIALLY overlap'; then
    echo "  self-check: and at $((nblk + 2)) blocks a partial overlap is STILL rejected"
  else
    echo "FAIL — at $((nblk + 2)) blocks the gate stopped detecting a partial overlap it was handed on purpose."
    echo "       Passing on volume alone is the failure this check exists to catch."
    echo "$dirty" | grep -E '^#O' | sed 's/^/       /'
    exit 1
  fi

  # The completeness half needs its own self-check, and for a sharper reason: on a fresh clone the real
  # check above SKIPs, so without this the gate would report a green C2b having compared nothing. One
  # split of a committed block gives all three verdicts from data already in the repo.
  t2="$(mktemp -d)"
  "$loft" --native --lib "$here/lib" "$here/tools/split_block.loft" "$src" "$t2/w" "$t2/e" 6.85 >/dev/null 2>&1
  both="$("$loft" --native --lib "$here/lib" "$here/tools/cell_diff.loft" "$src" "$t2/w" "$t2/e" 2>&1)"
  half="$("$loft" --native --lib "$here/lib" "$here/tools/cell_diff.loft" "$src" "$t2/w" 2>&1)"
  # Handing the SAME half twice: its cells are held twice (OVER — the way-count comparison firing) and the
  # other half's are held not at all (MISSING). That is what proves C2b's per-cell count is live, which is
  # exactly the comparison a cell-SET diff lacks and the one the banded build needed.
  dupe="$("$loft" --native --lib "$here/lib" "$here/tools/cell_diff.loft" "$src" "$t2/w" "$t2/w" 2>&1)"
  rm -rf "$t2"
  cfail=0
  echo "$both" | grep -q '^#C ALL PASS' || { echo "FAIL — two halves of one block no longer add up to it:"; echo "$both" | grep -E '^#C' | sed 's/^/       /'; cfail=1; }
  echo "$half" | grep -q '^#C MISSING' || { echo "FAIL — a half block handed alone is no longer reported as MISSING cells"; cfail=1; }
  echo "$dupe" | grep -q '^#C OVER'    || { echo "FAIL — a doubled half no longer trips the per-cell WAY COUNT (OVER)"; cfail=1; }
  [ "$cfail" = 0 ] || exit 1
  echo "  self-check: two halves add up; one half is caught MISSING ($(echo "$half" | grep -c '^#C MISSING') cells); a doubled half is caught OVER"
fi

if [ "$checked" -eq 0 ]; then
  echo "SKIP — no index has two blocks present locally"
  exit 2
fi
if [ $rc -ne 0 ]; then
  echo "FAIL — two blocks in ONE index share cells. A corridor there reads those roads twice and matches"
  echo "       a different route. Cut regions on cell boundaries from one extract (tools/split_block.loft)"
  echo "       rather than from per-country extracts, which overlap at every border."
  exit 1
fi
if [ "$complete_checked" -eq 0 ]; then
  echo "  (no cut_from source present locally — C2b checked only its self-check)"
fi
echo "PASS — every index's road blocks are disjoint by cell, and every cut set adds up to its source"
