#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# THE INDEXED SEARCH AGAINST THE SCAN — a differential gate over a corpus drawn from the real vocabulary.
#
# `do_find_indexed` answers from a word trie; `do_find` scans every NameRec and scores by where the query
# first appears in the fold. Those are different questions, so this does not assert they agree — it
# MEASURES how often they do, and fails only on the disagreements that are not accounted for.
#
# The accounted-for class is exactly one, and it is stated up front so a new one cannot hide in the rate:
#
#   TIER-0-ONLY — the scan finds the query INSIDE a word ("kerk" in "verkerkstraat") and the index, which
#   only knows word starts, does not. The index returns a SHORTER list, never a different one. §4 of
#   docs/name-search-index.md measured this at 8.5% of queries and it is why the caller falls back.
#
# Anything else — a different ORDER, a different NAME, the index returning MORE than the scan — is a real
# divergence and fails the gate.
#
#   tools/name_index_gate.sh [names.store] [index-prefix]
set -uo pipefail
cd "$(dirname "$0")/.."

LOFT="${LOFT_BIN:-$(command -v loft)}"
NAMES="${1:-scratch/names_copy.store}"
PREFIX="${2:-scratch/cov3}"
LIMIT="${LIMIT:-8}"

if [ ! -f "$NAMES" ] || [ ! -f "$PREFIX.nxwords.store" ]; then
  echo "  SKIP: needs $NAMES and $PREFIX.nx*.store — build them with tools/gen-names-index.loft"
  exit 0
fi

echo "== the indexed search answers what the scan answers =="
out="$(mktemp)"; trap 'rm -f "$out"' EXIT
"$LOFT" --native --lib lib tools/nx_parity.loft "$NAMES" "$PREFIX" "$LIMIT" 2>/dev/null > "$out" || {
  echo "  FAIL: the harness did not run"; exit 1; }

python3 - "$out" <<'PY'
import sys, collections
lines = open(sys.argv[1]).read().splitlines()
cases, q, mode = [], None, None
scan, idx, answered = [], [], True
def flush():
    if q is not None: cases.append((q, list(scan), list(idx), answered))
for ln in lines:
    if ln.startswith('#Q '):
        flush(); q = ln[3:]; scan, idx, answered = [], [], True; mode = None
    elif ln == '#S': mode = 's'
    elif ln == '#I': mode = 'i'
    elif ln.startswith('#E'): answered = ln.endswith('answered')
    elif ln.startswith('#P'): continue
    elif mode == 's': scan.append(ln)
    elif mode == 'i': idx.append(ln)
flush()

same = declined = shorter = bad = 0
examples = collections.defaultdict(list)
for q, s, i, ans in cases:
    if not ans:
        declined += 1
        continue
    if s == i:
        same += 1
        continue
    # A SHORTER list whose rows are a prefix-preserving subsequence of the scan's is the accounted-for
    # tier-0 class: the index missed interior matches, kept every one it found, and kept the order.
    srows = [x for x in s if x.startswith('FOUND ')]
    irows = [x for x in i if x.startswith('FOUND ')]
    it = iter(srows)
    subseq = all(any(r == c for c in it) for r in irows)
    if len(irows) < len(srows) and subseq:
        shorter += 1
        examples['shorter'].append(q)
    else:
        bad += 1
        examples['DIVERGED'].append((q, srows[:3], irows[:3]))

tot = len(cases)
print(f"  corpus            : {tot} queries")
print(f"  byte-identical    : {same}  ({100.0*same/max(1,tot):.1f}%)")
print(f"  declined (scan)   : {declined}")
print(f"  shorter, in order : {shorter}  <- the accounted-for tier-0 class")
print(f"  DIVERGED          : {bad}")
if examples['shorter'][:5]:
    print(f"    shorter e.g.    : {', '.join(examples['shorter'][:5])}")
for q, s, i in examples['DIVERGED'][:5]:
    print(f"    ! {q}")
    for r in s: print(f"        scan  {r}")
    for r in i: print(f"        index {r}")
sys.exit(1 if bad else 0)
PY
rc=$?
if [ $rc -ne 0 ]; then echo "  FAIL: the index and the scan disagree in a way nothing accounts for"; exit 1; fi
echo "  THE INDEXED SEARCH AGREES WITH THE SCAN"
