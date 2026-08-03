#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# THE UPSTREAM BUGS THIS TREE WORKS AROUND — are they still there?
#
# loft-lang/loft#739 — two symptoms of what looks like one fault: a type-id table shifted by declaring a
# `hash<T[key]>` over a library-imported struct. Both found while building PLAN-RESTORE R2.
#
# loft-lang/loft#757 — binding through a wrapper struct writes a file no bare-local reader can load. Found
# by baking heights into Belgium and Luxembourg, which left both blocks readable only by the tool that
# wrote them.
#
# ⚠ WE FILED THIS AS A BUG AND WERE REFUTED — the behaviour below is BY DESIGN, and the probe is a
# CONTRACT GUARD, not a defect watch. `store_persist_bind` binds the whole store the collection lives in;
# a keyed FIELD shares its container's store, a keyed LOCAL owns one. So a field bind genuinely writes a
# container-rooted file — siblings included — and `store_load` into a bare collection returning false is an
# HONEST REFUSAL. The alternative we asked for would have made that load SUCCEED and read the container
# record's bytes as a hash root: silent corruption in place of a clean failure. Upstream fixed the two real
# faults — a doc that claimed each keyed local OR FIELD owns a store, and the silence at the call site
# (the compiler now emits `advice` on a field bind, both backends). So this check must never be read as
# "still broken": it pins that a field bind stays DISTINGUISHABLE from a local one.
#
# ⚠ #739's TWO ARE `--native` ONLY. The interpreter answers correctly, so every gate that runs interpreted
# stays green while the generator-side tools break — which is exactly why this gate exists. #757 is not:
# it reproduces on both backends and needs no library at all.
#
#   loft_store_key_probe   a keyed lookup on a `store_persist_bind`-bound store ABORTS the process
#                          (`find called on non-collection type: <varies> (db=128)`)
#   loft_seek_probe        one of the sized binary reads (`f#read as u16`/`as i16`) returns NULL
#   loft_schema_probe      a wrapper-struct bind leaves the store unreadable by a bare-local reader
#
# ⚠ IT DID ITS JOB, AND THAT FLIPPED ITS EXIT CODE (2026-08-03). Both bugs are fixed upstream and both
# workarounds are DELETED — `gen_heights.loft` reads one `i16` again, and nothing forbids a keyed lookup
# any more. So the tree no longer routes around either, and a bug coming back is not a status report, it
# is a REGRESSION that breaks the height pipeline: this gate now FAILS on one being present. It used to
# exit 0 either way, which was right only while the workarounds existed.
#
# A probe outside a gate is a comment (CLAUDE.md), which is exactly why all three are in one.
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
echo "-- store_persist_bind through a wrapper struct (loft#757 — BY DESIGN; rule: bind a bare local)"
# ⚠ NOT a --native-only bug, unlike the two above: it reproduces on the interpreter too, which is why the
# probe takes no library and this check does not care which backend ran it.
out3="$("$loft" --native "$here/tools/loft_schema_probe.loft" "$work/schema.store" 2>&1)"
if grep -q '^#P FIXED' <<<"$out3"; then
  # ⚠ NOT the good news it reads as. Upstream declined to make a keyed field its own store — that is an
  # allocation-model change, deliberately not forced. So a bare-local reader accepting a field-bound file
  # means the ALLOCATION MODEL MOVED, and the honest refusal we rely on is gone. Re-read loft#757 before
  # deleting anything: reseat_schema and gen_heights' bare-local note stay until that is confirmed upstream.
  echo "   ⚠ CHANGED — a wrapper bind is now readable by a bare-local reader."
  echo "      This is an allocation-model change, not a bug fix. Confirm upstream before trusting it."
  fixed=$((fixed + 1))
elif grep -q '^#P BUG PRESENT' <<<"$out3"; then
  # The probe's own wording predates the refutation; the STATUS is "contract holds". Every tool here binds
  # a bare local, which is what the compiler now recommends at the call site.
  # The probe's marker still spells "BUG PRESENT" (it is the wire protocol two greps above depend on);
  # strip that half for display, because the STATUS is "contract holds", not "defect found".
  echo "   ✅ by design — $(grep '^#P BUG PRESENT' <<<"$out3" | sed 's/^#P BUG PRESENT — //')"
  echo "      Bind a BARE LOCAL, never a struct field: a field bind writes a CONTAINER-rooted file"
  echo "      (siblings included), so this refusal is honest. gen_heights did it the other way on"
  echo "      2026-08-03 and left Belgium and Luxembourg readable only by itself — records intact."
else
  echo "   ⚠ UNKNOWN — the probe reported neither:"; sed 's/^/     /' <<<"$out3" | tail -3
fi

echo
if [ "$bad" -gt 0 ]; then
  echo "FAIL — $bad upstream bug(s) are back, and the workarounds for them are gone."
  echo "       tools/height_gate.sh is what breaks next; git log tools/gen_heights.loft has the old shape."
  exit 1
fi
if [ "$fixed" -gt 0 ]; then
  echo "$fixed of 2 bugs fixed, plus one contract held. #739's two are regression guards — their"
  echo "workarounds are gone, so the gate FAILS if either returns. #757 is NOT a bug: we filed it, upstream"
  echo "refuted it, and a field bind writing a container-rooted file is the design. What the probe guards is"
  echo "that a field bind stays DISTINGUISHABLE from a local one — and the next in-place editor written the"
  echo "obvious way, which is exactly how gen_heights acquired it."
else
  echo "⚠ No probe reported a clear status — treat this run as NO information, not as a pass."
fi
exit 0
