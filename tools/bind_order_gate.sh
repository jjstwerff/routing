#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# WHICH BIND ORDER BOUNDS A GENERATOR'S MEMORY? — the gate under `tools/bind_order_probe.loft`.
#
# THE CLAIM THIS EXISTS TO KEEP HONEST. `plans/51-coverage-past-nl/` records that binding the store
# FIRST costs 4.5x the RSS of binding it last, and `PLAN-SCALE` §6e turns that into the rule Western
# Europe planning runs on: a WE-sized store is 130-270 GB, therefore never build one. Upstream
# re-measured after fixing loft#746 and got the reverse — 4.4x BETTER — and pointed out that a bound
# store is file-backed, so its pages can be evicted and the dataset stops setting a memory floor at all
# (loft#747). Two contradicting numbers, both from throwaway probes on binaries that no longer exist.
#
# So this is not a pass/fail check on loft. It is the measurement itself, in the tree, re-runnable
# against whichever binary is installed today — because the thing that went wrong last time was not the
# arithmetic, it was that nobody could re-run it.
#
#   tools/bind_order_gate.sh [roads] [tiles] [steps-per-road]
#
# It FAILS only on a wrong result — a store whose read-back disagrees with what the generator says it
# built. A generator that used less memory because it wrote less is not a cheaper generator, and peak RSS
# alone cannot tell those apart. The RSS numbers themselves are reported, never asserted: they are a
# property of the loft release, and pinning them here would turn every upstream improvement into a
# failing gate.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
nroad="${1:-400000}"
ntile="${2:-40000}"
spr="${3:-10}"
work="${TMPDIR:-/tmp}/bind-order-$$"
mkdir -p "$work"
# NAMED directory, and `-r` only because it is one we just made. HANDOFF §2: `rm -f "$var"*` with an
# unset var deleted 37 tracked files from the repo root, which is why `set -u` is on above.
trap 'rm -rf "$work"' EXIT

command -v /usr/bin/time >/dev/null || { echo "SKIP: /usr/bin/time not found (need it for peak RSS)"; exit 2; }

# ⚠ ANCHOR THE CLAIM TO THE BINARY, never to `--version` alone — /usr/local/bin/loft has changed three
# times in two days while printing the same string, once mid-session halfway through a bug hunt.
echo "== bind order: does binding FIRST bound the working set? =="
echo "   loft $("$loft" --version 2>&1 | head -1) · md5 $(md5sum "$loft" | cut -c1-32) · $(stat -c%y "$loft" | cut -d. -f1)"
echo "   binning $nroad roads into $ntile tiles, $spr steps per road"
# Wall time is reported but it is the number to distrust: sibling loft builds have put this box at load
# 25 and manufactured a fake regression. RSS does not care about load; wall does.
echo "   load$(uptime | sed 's/.*load average//')"
echo

# ⚠ WARM THE COMPILE CACHE FIRST. `--native` forks rustc, which peaks around 200 MB — several times the
# thing being measured — so an unwarmed first run reports the compiler's memory as the generator's.
# Upstream's own first pass was contaminated exactly this way. Same program, tiny input, result discarded.
printf '   warming the compile cache … '
"$loft" --native --lib "$here/lib" "$here/tools/bind_order_probe.loft" \
  "$work/warm.store" 200 20 last scattered 2 >/dev/null 2>&1
echo "done"
echo

printf '   %-8s %-10s %10s %12s %10s  %s\n' mode order "peak RSS" "file" wall result
fail=0
declare -A rss_of
for order in scattered ordered; do
  for mode in first last; do
    out="$work/$mode-$order.store"
    log="$work/$mode-$order.log"
    rssf="$work/$mode-$order.rss"
    # %M is peak RSS in KB, %e wall seconds. Written to a file so the probe keeps its own stdout.
    /usr/bin/time -f '%M %e' -o "$rssf" \
      "$loft" --native --lib "$here/lib" "$here/tools/bind_order_probe.loft" \
      "$out" "$nroad" "$ntile" "$mode" "$order" "$spr" >"$log" 2>&1
    built="$(grep -m1 '^#B' "$log" || true)"
    if [ -z "$built" ]; then
      printf '   %-8s %-10s %10s %12s %10s  %s\n' "$mode" "$order" - - - "BUILD FAILED"
      grep -E 'panic|error|FAIL' "$log" | head -3 | sed 's/^/      /'
      fail=1; continue
    fi
    kb="$(awk '{print $1}' "$rssf")"; wall="$(awk '{print $2}' "$rssf")"
    bytes="$(stat -c%s "$out" 2>/dev/null || echo 0)"

    # THE CORRECTNESS HALF, in its own process so the read-back cannot inflate the write's RSS. Compare
    # what came out of the file against what the generator said it put in — not against a number this
    # script predicted, which would only re-state the probe's own arithmetic.
    "$loft" --native --lib "$here/lib" "$here/tools/bind_order_probe.loft" \
      "$out" - - verify >"$log.v" 2>&1
    read_back="$(grep -m1 '^#V' "$log.v" || true)"
    want="$(echo "$built" | grep -oP 'roads=\K[0-9]+') $(echo "$built" | grep -oP 'steps=\K[0-9]+')"
    got="$(echo "$read_back" | grep -oP 'roads=\K[0-9]+') $(echo "$read_back" | grep -oP 'steps=\K[0-9]+')"
    if [ -z "$read_back" ] || [ "$want" != "$got" ]; then
      printf '   %-8s %-10s %8s MB %9s MB %9ss  %s\n' "$mode" "$order" \
        "$((kb / 1024))" "$((bytes / 1000000))" "$wall" "WRONG CONTENTS"
      echo "      built    $built"
      echo "      read back $read_back"
      fail=1; continue
    fi
    rss_of["$mode-$order"]="$kb"
    printf '   %-8s %-10s %8s MB %9s MB %9ss  %s\n' "$mode" "$order" \
      "$((kb / 1024))" "$((bytes / 1000000))" "$wall" "ok, round-trips"
  done
done

echo
if [ "$fail" != 0 ]; then
  echo "FAIL — a generator produced a store that does not read back as what it built."
  exit 1
fi

# The ratio is the whole point of the table, so state it rather than leaving it to be divided by eye.
for order in scattered ordered; do
  f="${rss_of[first-$order]:-0}"; l="${rss_of[last-$order]:-0}"
  [ "$f" -gt 0 ] && [ "$l" -gt 0 ] || continue
  # Say which way round it is IN WORDS. The first version of this line divided last/first and then
  # labelled it "bind-first is Nx the RSS of bind-last", i.e. reported a 3.4x WIN as a 3.4x loss — the
  # exact inversion this gate exists to stop being copied into a plan.
  ratio="$(awk -v a="$l" -v b="$f" 'BEGIN{printf "%.2f", (a>b ? a/b : b/a)}')"
  if [ "$f" -lt "$l" ]; then
    echo "   $order: bind-FIRST is cheaper — ${ratio}x LOWER peak RSS ($((f / 1024)) MB vs $((l / 1024)) MB)"
  else
    echo "   $order: bind-LAST is cheaper — ${ratio}x lower peak RSS ($((l / 1024)) MB vs $((f / 1024)) MB)"
  fi
done

# --- IS THE MEMORY RECLAIMABLE? ----------------------------------------------------------------------
# The ratio above is the smaller half of the question. What decides whether Western Europe needs a
# chunking layer is whether a bound store's pages can be EVICTED — if they can, dataset size buys a
# throughput cost rather than a memory requirement, and `PLAN-SCALE` §6e's "never build one that big"
# loses its premise.
#
# ⚠ `MemoryMax` ALONE PROVES NOTHING ON A BOX WITH SWAP, and the first run of this measured exactly
# that: both orders "completed" under a 96 MB cap because this machine has 8 GB of swap and bind-last's
# anonymous heap simply paged out. `MemorySwapMax=0` is what separates file-backed eviction from
# ordinary swapping, and with it the two orders come apart immediately.
if command -v systemd-run >/dev/null 2>&1; then
  f_un="${rss_of[first-scattered]:-0}"; l_un="${rss_of[last-scattered]:-0}"
  # Half the UNCAPPED bind-first figure, so the cap always bites by construction rather than by luck —
  # a cap above what the run wanted would report a pass for a limit that never applied. Floored at 48 MB:
  # below that the loft runtime's own fixed cost dominates (measured: 400k completes at 48 MB, dies at 32).
  cap_mb=$((f_un / 2048)); [ "$cap_mb" -lt 48 ] && cap_mb=48
  echo "   under a ${cap_mb} MB cap with swap DISABLED (uncapped: first $((f_un / 1024)) MB, last $((l_un / 1024)) MB):"
  for mode in first last; do
    out="$work/cap-$mode.store"
    rm -f "$out" "$out.dschema"
    systemd-run --user --scope -q -p MemoryMax=${cap_mb}M -p MemorySwapMax=0 \
      "$loft" --native --lib "$here/lib" "$here/tools/bind_order_probe.loft" \
      "$out" "$nroad" "$ntile" "$mode" scattered "$spr" >"$work/cap-$mode.log" 2>&1
    if grep -q '^#B' "$work/cap-$mode.log"; then
      "$loft" --native --lib "$here/lib" "$here/tools/bind_order_probe.loft" \
        "$out" - - verify >"$work/cap-$mode.v" 2>&1
      printf '     bind-%-6s COMPLETED — %s\n' "$mode" "$(grep -oP '^#V \K.*' "$work/cap-$mode.v" || echo '?')"
    else
      printf '     bind-%-6s OOM-KILLED at this cap\n' "$mode"
      # Only bind-FIRST is asserted. bind-last dying is the expected control, and a future loft that made
      # it survive would be an improvement — pinning it here would turn that into a failure.
      [ "$mode" = first ] && { echo "FAIL — a bound store could not complete in half its own uncapped RSS."; exit 1; }
    fi
  done
else
  echo "   (skipped the eviction test: no systemd-run for a cgroup cap)"
fi

echo
echo "   Read it against the two claims on record:"
echo "     plans/51-coverage-past-nl  bind-first is 4.5x WORSE   (loft 2026.8.0, md5 0849e437…, pre-#746)"
echo "     loft#747 comment           bind-first is 4.4x BETTER  (upstream main, post-#746)"
echo "   Whichever this box reports, PLAN-SCALE §6e's 130-270 GB figure is a bind-LAST measurement."
exit 0
