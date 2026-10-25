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
# ⚠ BIND-FIRST IS GONE. loft removed `store_persist_bind` (2026-11): a collection is never file-backed,
# so every generator builds in memory and writes once with `store_persist_copy`. Only that order is left
# to run, the first-vs-last ratio has no second row, and the eviction test (can a BOUND store finish in
# half its own RSS?) has no subject. What this still measures is a generator's peak RSS on the installed
# binary, and that what it built reads back. ⚠ For PLAN-SCALE §6e that means the memory floor is the
# in-memory dataset again — loft#747's way around it (file-backed pages that can be evicted) went with
# binding.
#
# So this is not a pass/fail check on loft. It is the measurement itself, in the tree, re-runnable
# against whichever binary is installed today — because the thing that went wrong last time was not the
# arithmetic, it was that nobody could re-run it.
#
#   tools/bind_order_gate.sh [roads] [tiles] [steps-per-road]
#
# ⚠ THE SIZE COLUMN IS CONTENT, NOT `stat -c%s`, and the difference cost a wrong finding filed upstream.
# A bound store's FILE is its CAPACITY, quantized to a ladder whose every rung is 7/3 of the last
# (loft#752): 250 000, 300 000 and 400 000 roads all persist to exactly 91 419 400 bytes, while a single
# rung tip looks like a 133% regression. The probe calls `store_reclaim` before this reads the file, so
# the column means what it says. Never compare raw store sizes without it.
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
echo "== generator memory: build in memory, write once (store_persist_copy) =="
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

printf '   %-8s %-10s %10s %12s %10s  %s\n' mode order "peak RSS" "content" wall result
fail=0
declare -A rss_of
for order in scattered ordered; do
  for mode in last; do
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

echo "   Bind-first is not measured: loft removed store_persist_bind (2026-11), so there is no such order."
echo "   The claims on record compared the two, and neither can be re-run on this loft:"
echo "     plans/51-coverage-past-nl  bind-first is 4.5x WORSE   (loft 2026.8.0, md5 0849e437…, pre-#746)"
echo "     loft#747 comment           bind-first is 4.4x BETTER  (upstream main, post-#746)"
echo "   PLAN-SCALE §6e's 130-270 GB figure is a bind-LAST measurement — the only order there is now."
exit 0
