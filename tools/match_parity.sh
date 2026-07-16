#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-PERF §0 step 8 — THE gate for the incremental matcher.
#
# `match_incremental` recomputes only the edited window of a cached MatchState. That is the whole point,
# and it is also the one place in the session work where a wrong port SILENTLY changes what the user
# gets: a route that is merely plausible still draws. So the acceptance is EQUALITY, not speed —
# the incremental result must be byte-identical to a full match on the same graph.
#
# Drives the session kernel with a sketch, then a MOVED point (the warm/covered path that goes through
# match_incremental), and compares each against the one-shot do_match path for the same input.
#   tools/match_parity.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
store="$here/_site/stores/enschede.roads.store"
[ -f "$store" ] || { echo "SKIP: no roads store at $store (build: node browser/build-site.mjs)"; exit 2; }

probe="$(mktemp -d)/parity.loft"
cat > "$probe" <<'LOFT'
// Same trace, two paths: the one-shot do_match (builds a fresh corridor+graph, full search) and the
// session path (cached graph + match_incremental). Their ROUTE lines must be byte-identical.
#cwd
use map_kernel::(do_match, do_match_session, session_new, parse_sketch, MatchSession);
use routing_kernel::(TTile);

// Every sketch is driven through BOTH paths and compared. ONE session spans them all, exactly as a
// user's clicks do — so later sketches hit a session already holding a corridor from earlier ones.
fn check(roads: hash<TTile[tkey]>, s: MatchSession, tag: text, spec: text, profile: text) {
  println("--ONESHOT-{tag}--"); do_match(roads, parse_sketch(spec), profile);
  println("--SESSION-{tag}--"); do_match_session(s, roads, parse_sketch(spec), profile);
}

fn main() {
  a = arguments();
  roads: hash<TTile[tkey]> = [];
  if !store_load(roads, a[0] ?? "") { println("ERR store_load"); return; }
  profile = a[1] ?? "cycling_road";
  s = session_new();
  // A: the base sketch (cold — fresh state).   B: A with a point MOVED ~110m — inside the corridor, so
  // covered() holds and this is the match_incremental path under test.   C/D/E: DIFFERENT areas, each
  // producing a genuinely different route, so agreement across them is meaningful rather than trivial.
  check(roads, s, "A", "52.2412299,6.8834496;52.2694705,6.9164085;52.3116272,6.9088554", profile);
  check(roads, s, "B", "52.2412299,6.8834496;52.2704705,6.9174085;52.3116272,6.9088554", profile);
  check(roads, s, "C", "52.1800,6.8300;52.2000,6.8600", profile);
  check(roads, s, "D", "52.2200,6.7900;52.2400,6.8200", profile);
  check(roads, s, "E", "52.2412299,6.8834496;52.2694705,6.9164085;52.3116272,6.9088554", profile);
}
LOFT

echo "== match parity: session (cached graph + match_incremental) vs one-shot (fresh graph, full search) =="
out="$("$loft" --native "$probe" --lib "$here/lib" "$store" cycling_road 2>&1)" || { echo "$out" | tail -3; exit 1; }

# Compare what the USER gets: the ROUTE polyline, its point count and its length. `ways=` is excluded on
# purpose — it reports the CORRIDOR size, and a session legitimately matches on its cached (smaller)
# corridor while a one-shot builds a fresh one for the same sketch. Identical route from fewer ways is
# covered() working, not a divergence; the route is the contract.
sect() { echo "$out" | sed -n "/^--$1--\$/,/^--/p" | grep -E '^(ROUTE|SUMMARY)' | sed 's/ways=[0-9]* //'; }
corridor() { echo "$out" | sed -n "/^--$1--\$/,/^--/p" | grep -oE 'ways=[0-9]+'; }
fail=0
for pair in "A cold(first match, fresh state)" "B warm(point moved ~110m → covered ⇒ match_incremental)" "C new-area(corridor miss ⇒ rebuild)" "D new-area(corridor miss ⇒ rebuild)" "E revisit-A(session already holds another area)"; do
  set -- $pair; t="$1"; shift; label="$*"; a="ONESHOT-$t"; b="SESSION-$t"
  if [ -z "$(sect "$b")" ]; then echo "  ❌ $label — no output"; fail=1; continue; fi
  if [ "$(sect "$a")" = "$(sect "$b")" ]; then
    echo "  ✅ $label — byte-identical"
    echo "$out" | sed -n "/^--$b--\$/,/^--/p" | grep '^SUMMARY' | sed 's/^/       /'
    echo "       corridor: one-shot $(corridor "$a") · session $(corridor "$b")  (may differ — cached vs fresh)"
  else
    echo "  ❌ $label — THE ROUTE DIFFERS"
    diff <(sect "$a") <(sect "$b") | head -6 | sed 's/^/       /'
    fail=1
  fi
done
# The gate is only meaningful if the moved sketch actually produces a DIFFERENT route — otherwise both
# paths agree trivially and nothing is being tested.
# Distinct routes across the cases ⇒ agreement is meaningful rather than "everything returns the same
# thing". A covered MOVE cannot change the route here (covered() allows ~170m; the road net is coarser),
# so the variety comes from the different areas.
n_distinct="$(for t in A B C D E; do sect "ONESHOT-$t" | grep '^SUMMARY'; done | sort -u | wc -l)"
if [ "$n_distinct" -lt 3 ]; then
  echo "  ⚠ WEAK: only $n_distinct distinct routes across 5 cases — the gate cannot discriminate."
  fail=1
else
  echo "  ✓ discriminating: $n_distinct distinct routes across the 5 cases, all matched by the session path"
fi
[ "$fail" = 0 ] && echo "PASS — the incremental matcher returns the full matcher's route" || echo "FAIL — incremental diverges or the gate is weak"
exit $fail
