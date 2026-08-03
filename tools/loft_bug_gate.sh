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
# ⚠ THIS GATE IS NOT "the bugs must stay". It reports their status and always exits 0 on the bug being
# PRESENT, because the tree already routes around both. It exists so the workarounds are DELETED when
# upstream fixes them, rather than outliving the reason for them: `tools/gen_heights.loft` iterates
# instead of looking up, and reads two bytes instead of one u16, and both carry a comment pointing here.
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

echo
echo "-- keyed lookup on a bound store (workaround: iterate; gen_heights.loft)"
# ⚠ ON A COPY, never the committed fixture. `store_persist_bind` rewrites the `.dschema` sidecar to name
# the binding program's own wrapper struct and changes the schema hash — which loft#705 gates `store_load`
# on. A gate that merely READS a block must not be able to make it unloadable.
cp "$here/browser/stores/enschede.roads.store" "$work/fixture.store"
cp "$here/browser/stores/enschede.roads.store.dschema" "$work/fixture.store.dschema" 2>/dev/null || true
out="$("$loft" --native --lib "$here/lib" "$here/tools/loft_store_key_probe.loft" "$work/fixture.store" 2>&1)"
if grep -q '^#P SKIP' <<<"$out"; then
  echo "   SKIP — $(grep '^#P SKIP' <<<"$out" | head -1)"
elif grep -q 'find called on non-collection type' <<<"$out"; then
  echo "   bug PRESENT — $(grep -o 'find called on non-collection type: .*' <<<"$out" | head -1)"
elif grep -q '^#P FIXED' <<<"$out"; then
  echo "   ✅ FIXED — a keyed lookup no longer aborts. Delete the iterate-only workaround in gen_heights.loft."
  fixed=$((fixed + 1))
else
  echo "   ⚠ UNKNOWN — the probe neither aborted nor reported FIXED:"; sed 's/^/     /' <<<"$out" | tail -5
fi

echo
echo "-- sized binary reads (workaround: two u8 reads; gen_heights.loft)"
out2="$("$loft" --native --lib "$here/lib" "$here/tools/loft_seek_probe.loft" "$work/probe.bin" 2>&1)"
if grep -q '^#S BUG PRESENT' <<<"$out2"; then
  echo "   bug PRESENT — $(grep '^#S BUG PRESENT' <<<"$out2" | head -1 | sed 's/^#S //')"
  grep '^#S as' <<<"$out2" | sed 's/^/     /'
elif grep -q '^#S FIXED' <<<"$out2"; then
  echo "   ✅ FIXED — every sized read is correct. Delete the two-byte read in gen_heights.loft's grid_h."
  fixed=$((fixed + 1))
else
  echo "   ⚠ UNKNOWN — the probe reported neither:"; sed 's/^/     /' <<<"$out2" | tail -5
fi

echo
if [ "$fixed" -gt 0 ]; then
  echo "$fixed workaround(s) can now be removed — see the lines above. (Still exit 0: nothing is broken.)"
else
  echo "Both bugs still present; the workarounds stay. docs/loft-feedback.md 2026-08-03 has the write-up."
fi
exit 0
