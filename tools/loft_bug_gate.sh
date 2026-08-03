#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# THE UPSTREAM BUGS THIS TREE WORKS AROUND — are they still there?
#
# loft-lang/loft#739 — two symptoms of what looks like one fault: a type-id table shifted by declaring a
# `hash<T[key]>` over a library-imported struct. Both found while building PLAN-RESTORE R2.
#
# ⚠ BOTH ARE `--native` ONLY. The interpreter answers correctly, so every gate that runs interpreted stays
# green while the generator-side tools break — which is exactly why this gate exists.
#
#   loft_store_key_probe   a keyed lookup on a `store_persist_bind`-bound store ABORTS the process
#                          (`find called on non-collection type: <varies> (db=128)`)
#   loft_seek_probe        one of the sized binary reads (`f#read as u16`/`as i16`) returns NULL
#
# ⚠ IT DID ITS JOB, AND THAT FLIPPED ITS EXIT CODE (2026-08-03). Both bugs are fixed upstream and both
# workarounds are DELETED — `gen_heights.loft` reads one `i16` again, and nothing forbids a keyed lookup
# any more. So the tree no longer routes around either, and a bug coming back is not a status report, it
# is a REGRESSION that breaks the height pipeline: this gate now FAILS on one being present. It used to
# exit 0 either way, which was right only while the workarounds existed.
#
# A probe outside a gate is a comment (CLAUDE.md), which is exactly why these two are in one.
#
#   tools/loft_bug_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
work="${TMPDIR:-/tmp}/loft-bug-gate-$$"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

# ⚠ ANCHOR THE CLAIM TO THE BINARY, never to `--version` alone: /usr/local/bin/loft has changed twice
# mid-session while printing the same string, and a status reported against the wrong one is worse than
# none. This is CLAUDE.md's rule applied to the one gate whose whole subject is the toolchain.
echo "== upstream bug status =="
echo "   loft $("$loft" --version 2>&1 | head -1) · md5 $(md5sum "$loft" | cut -c1-32) · $(stat -c%y "$loft" | cut -d. -f1)"

fixed=0
bad=0

echo
echo "-- keyed lookup on a bound store (loft#739; workaround deleted 2026-08-03)"
# ⚠ ON A COPY, never the committed fixture. `store_persist_bind` rewrites the `.dschema` sidecar to name
# the binding program's own wrapper struct and changes the schema hash — which loft#705 gates `store_load`
# on. A gate that merely READS a block must not be able to make it unloadable.
cp "$here/browser/stores/enschede.roads.store" "$work/fixture.store"
cp "$here/browser/stores/enschede.roads.store.dschema" "$work/fixture.store.dschema" 2>/dev/null || true
out="$("$loft" --native --lib "$here/lib" "$here/tools/loft_store_key_probe.loft" "$work/fixture.store" 2>&1)"
if grep -q '^#P SKIP' <<<"$out"; then
  echo "   SKIP — $(grep '^#P SKIP' <<<"$out" | head -1)"
elif grep -q 'find called on non-collection type' <<<"$out"; then
  echo "   ⛔ REGRESSION — $(grep -o 'find called on non-collection type: .*' <<<"$out" | head -1)"
  echo "      Fixed upstream and the workaround removed — the tree no longer routes around this."
  bad=$((bad + 1))
elif grep -q '^#P FIXED' <<<"$out"; then
  echo "   ✅ still fixed — a keyed lookup does not abort. (Regression guard; nothing to remove.)"
  fixed=$((fixed + 1))
else
  echo "   ⚠ UNKNOWN — the probe neither aborted nor reported FIXED:"; sed 's/^/     /' <<<"$out" | tail -5
fi

echo
echo "-- sized binary reads (loft#739; workaround deleted 2026-08-03)"
out2="$("$loft" --native --lib "$here/lib" "$here/tools/loft_seek_probe.loft" "$work/probe.bin" 2>&1)"
if grep -q '^#S BUG PRESENT' <<<"$out2"; then
  echo "   ⛔ REGRESSION — $(grep '^#S BUG PRESENT' <<<"$out2" | head -1 | sed 's/^#S //')"
  grep '^#S as' <<<"$out2" | sed 's/^/     /'
  echo "      gen_heights.loft reads one i16 again — a null here gives every step no height, silently."
  bad=$((bad + 1))
elif grep -q '^#S FIXED' <<<"$out2"; then
  echo "   ✅ still fixed — every sized read is correct. (Regression guard; nothing to remove.)"
  fixed=$((fixed + 1))
else
  echo "   ⚠ UNKNOWN — the probe reported neither:"; sed 's/^/     /' <<<"$out2" | tail -5
fi

echo
if [ "$bad" -gt 0 ]; then
  echo "FAIL — $bad upstream bug(s) are back, and the workarounds for them are gone."
  echo "       tools/height_gate.sh is what breaks next; git log tools/gen_heights.loft has the old shape."
  exit 1
fi
if [ "$fixed" -gt 0 ]; then
  echo "Both fixed, both workarounds removed. This gate is a regression guard now, not a to-do list."
else
  echo "⚠ Neither probe reported a clear status — treat this run as NO information, not as a pass."
fi
exit 0
