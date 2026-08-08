#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# THE DOCS GATE — are the docs COMPLETE, FINDABLE and HONEST ABOUT BEING CURRENT?
#
# `docs/doc-structure-design.md` §5. Every defect that design measured was mechanically detectable,
# and *"a probe outside a gate is a comment"* — so they are checked here, on every `make test`.
# It needs no loft, no browser and no data: it reads Markdown and `git ls-files`.
#
# WHAT IT IS NOT. It does not read the docs for you and it cannot tell you a claim went wrong. It
# checks the five things that are decidable from the tree, all of which were true on 2026-08-07:
#
#   1. a doc existed that the index did not list, while §0 and §1 told you to read it  (5 of 8 in docs/)
#   2. a doc pointed at a path that a rename had moved out from under it
#   3. a doc gave no way to tell what it was for without reading all of it
#   4. a month-old plan read exactly like this morning's, because nothing said otherwise
#   5. two files had grown to ~2 200 lines by being four kinds of document at once
#
# ⚠ RULE 4 NEVER FAILS FOR AGE. Old is fine — most of this tree is old and correct. It fails for a
# SILENT claim of currency: a doc that says `Status: current` while its `Last verified` has aged past
# the window. Declaring `stale` always passes. The point is that the reader is told.
#
# ⚠ `Last verified` MEANS SOMEONE RE-CHECKED THE CLAIMS, not that the file was edited. The dates this
# gate landed with are each doc's last substantive edit, adopted as a LOWER BOUND — that is the only
# thing the tree actually knows, and it errs toward "older than it says", which is the safe direction.
# The first person to genuinely re-check a doc moves its date to that day. Do not touch the date for a
# typo fix. This repo has already shipped a doc that was correct when written and wrong eight weeks
# later (`docs/loft-binary-bridge.md`, whose premise a later commit removed) — that is the failure
# this field exists to make visible.
#
# EXEMPTIONS live in `tools/docs_gate.exempt`, one line each, WITH A REASON. They are meant to be read:
# every entry is a place where a rule and a convention disagree, and the reason is the resolution.
#
#   tools/docs_gate.sh
#     DOCS_GATE_VERBOSE=1   print every doc that passes, not just the failures
#     DOCS_GATE_BUDGETS=warn  demote rule 5 to a warning. It landed warning-only because PLAN-SCALE and
#                             PLAN-PERF were ~2 200 lines each; both were split on 2026-08-07 and it now
#                             FAILS (the design's step 7). Demoting it is for a work-in-progress tree,
#                             never for a commit.
#     DOCS_GATE_TODAY=YYYY-MM-DD   pin "now", so the gate's own behaviour is testable
set -uo pipefail
export LC_ALL=C
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here" || exit 1

today="${DOCS_GATE_TODAY:-$(date +%F)}"
stale_days="${DOCS_GATE_STALE_DAYS:-90}"
plan_budget="${DOCS_GATE_PLAN_BUDGET:-300}"
ref_budget="${DOCS_GATE_REF_BUDGET:-800}"
budget_mode="${DOCS_GATE_BUDGETS:-fail}"
exempt_file="tools/docs_gate.exempt"
index_file="HANDOFF.md"
index_section='## 4. Where the docs are'

fail=0
warns=0
ok()   { [ -n "${DOCS_GATE_VERBOSE:-}" ] && printf '  \342\234\223 %s\n' "$1"; return 0; }
bad()  { printf '  FAIL: %s\n' "$1"; fail=1; }
warn() { printf '  warn: %s\n' "$1"; warns=$((warns + 1)); }

# The doc set: everything tracked OR newly written, minus two trees that are documentation of
# something else.
#   .github/ISSUE_TEMPLATE — GitHub forms with YAML front matter, not prose we own
#   lib/*/README.md        — loft libraries whose home is the registry (loft.toml: server/web are
#                            vendored); routing's own kernels carry no README
#
# ⚠ `--others` is not optional. `git ls-files` alone sees only TRACKED files, so a doc you just wrote
# is invisible to every rule below until you `git add` it — which is exactly the moment rule 1 exists
# to catch you. Found by splitting PLAN-SCALE into five files and watching the gate report 38 docs.
# `--exclude-standard` keeps .gitignore honoured, so scratch/ and _site/ stay out.
docset() {
  { git ls-files '*.md'; git ls-files --others --exclude-standard '*.md'; } \
    | grep -Ev '^(\.github|lib)/' | sort -u
}

# exempt <doc> <rule> <subject> — both the doc column and the subject column are globs.
exempt() {
  local doc="$1" rule="$2" subj="$3" d r pat _reason
  [ -f "$exempt_file" ] || return 1
  while IFS="$(printf '\t')" read -r d r pat _reason; do
    case "$d" in ""|\#*) continue ;; esac
    [ "$r" = "$rule" ] || continue
    # shellcheck disable=SC2254  # the columns are globs on purpose
    case "$doc" in $d) ;; *) continue ;; esac
    # shellcheck disable=SC2254
    case "$subj" in $pat) return 0 ;; esac
  done < "$exempt_file"
  return 1
}

days_since() { # <YYYY-MM-DD> -> whole days before $today; fails on anything that is not that shape
  local then_s now_s
  # The shape check is NOT redundant with `date -d`. GNU date parses English — `last Tuesday`,
  # `yesterday`, `now` all succeed and yield a moving target. The gate's own self-test caught this
  # spelled exactly that way, on its first run.
  printf '%s' "$1" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || return 1
  then_s="$(date -d "$1" +%s 2>/dev/null)" || return 1
  now_s="$(date -d "$today" +%s 2>/dev/null)" || return 1
  echo $(((now_s - then_s) / 86400))
}

# --- the self-declaring header ---------------------------------------------------------------------
# Two spellings, one grammar. Internal docs carry it visibly; the four files a stranger arrives at
# (README, CONTRIBUTING, CODE_OF_CONDUCT, ATTRIBUTION) carry it as an HTML comment, because a currency
# banner addressed to us is noise addressed to them. Neither is exempt from the rule.
#
#   **Kind:** reference · **Status:** current · **Last verified:** 2026-08-07 · **Owns:** one line
#   <!-- Kind: guide · Status: current · Last verified: 2026-08-07 · Owns: one line -->
#
# `Owns:` may wrap onto following lines; the paragraph ends at the first blank line.
HK=; HS=; HD=; HO=
parse_header() {
  local f="$1" raw h
  raw="$(awk 'NR>12 && !f {exit}
              !f && (/^\*\*Kind:\*\*/ || /^<!-- Kind:/) {f=1}
              f { if ($0 ~ /^[[:space:]]*$/) exit; print }' "$f")"
  [ -n "$raw" ] || return 1
  h="$(printf '%s' "$raw" | tr '\n' ' ' \
       | sed -E 's/\*\*//g; s/^<!--[[:space:]]*//; s/[[:space:]]*-->[[:space:]]*$//; s/[[:space:]]+$//')"
  HK="$(printf '%s' "$h" | awk -v FS=' · ' '{print $1}' | sed -E 's/^Kind:[[:space:]]*//')"
  HS="$(printf '%s' "$h" | awk -v FS=' · ' '{print $2}' | sed -E 's/^Status:[[:space:]]*//')"
  HD="$(printf '%s' "$h" | awk -v FS=' · ' '{print $3}' | sed -E 's/^Last verified:[[:space:]]*//')"
  HO="$(printf '%s' "$h" | awk -v FS=' · ' '{print $4}' | sed -E 's/^Owns:[[:space:]]*//')"
  return 0
}

# --- what counts as a pointer AT US -----------------------------------------------------------------
# Measured 2026-08-07: of 65 distinct `*.md` citations in the tree, 30 name a doc in ANOTHER repo
# (`LOFT.md`, `WEB_APPS.md`, `doc/claude/PACKAGES.md` — the loft reference the CLAUDE.md table sends
# you to) or a template slot (`plans/<N>-<slug>/README.md`). Checking those would bury the two real
# hits, so the rule is: a citation is ours when its first path segment is a real directory here, or
# when it is a bare name in this repo's root-doc shape. `PLAN-ROUTING.md` is caught by the second
# clause, which is the point of having it.
checkable() {
  local p="$1"
  case "$p" in
    ../*|http*|*'<'*|*'>'*|*'*'*|*'?'*|*' '*|.md) return 1 ;;
  esac
  case "$p" in
    */*) [ -d "${p%%/*}" ] || return 1 ;;
    PLAN*.md|README.md|DESIGN.md|HANDOFF.md|CLAUDE.md|CONTRIBUTING.md|CODE_OF_CONDUCT.md|ATTRIBUTION.md|_TEMPLATE.md) ;;
    *) return 1 ;;
  esac
  return 0
}

cites() { # <file> -> every .md path it names, in backticks or as a link target
  { grep -oE '`[^`]+\.md`' "$1" | tr -d '`'
    grep -oE '\]\([^)]+\.md[^)]*\)' "$1" | sed -E 's/^\]\(//; s/\)$//; s/#.*$//'
  } 2>/dev/null | sort -u
}

echo "== the docs gate: complete, findable, honest about being current =="

# --- 1. no orphans ----------------------------------------------------------------------------------
# The one that pays for itself: on 2026-08-07 this would have caught all five missing docs/ files.
grep -qF "$index_section" "$index_file" \
  || { echo "  FAIL: $index_file has no '$index_section' — the index this gate checks against is gone"; exit 1; }
index="$(awk -v want="$index_section" '$0 == want {f=1; next} /^## / {f=0} f' "$index_file")"
[ -n "$index" ] || { echo "  FAIL: $index_section is empty"; exit 1; }

printf -- '-- 1. every doc is reachable from %s \302\2474\n' "$index_file"
while read -r doc; do
  if exempt "$doc" orphan "$doc"; then ok "$doc (exempt)"; continue; fi
  # A WHOLE-PATH match, not a substring: `plans/README.md` in the index must not be what makes the
  # root `README.md` look listed. The boundary class excludes `/`, which is the whole trick.
  esc="${doc//./\\.}"
  if printf '%s' "$index" | grep -qE "(^|[^A-Za-z0-9._/-])$esc([^A-Za-z0-9._/-]|\$)"; then
    ok "$doc"
  else
    bad "$doc is in the tree but not in $index_file $(printf '\302\247')4 — the next session will not find it"
  fi
done < <(docset)

# --- 2. no dangling pointers ------------------------------------------------------------------------
echo "-- 2. every path a doc points at exists"
while read -r doc; do
  while read -r p; do
    [ -n "$p" ] || continue
    checkable "$p" || continue
    exempt "$doc" dangling "$p" && continue
    [ -f "$(dirname "$doc")/$p" ] || [ -f "$p" ] \
      || bad "$doc points at \`$p\`, which does not exist — a rename that missed a caller"
  done < <(cites "$doc")
done < <(docset)

# --- 3/4/5. the header, its honesty, and the budget -------------------------------------------------
echo "-- 3. every doc declares its kind, status and last-verified date"
echo "-- 4. no doc silently claims to be current (window: $stale_days days, today $today)"
printf -- '-- 5. budgets: plan \342\211\244 %s lines, reference \342\211\244 %s (%s)\n' \
  "$plan_budget" "$ref_budget" "$budget_mode"
while read -r doc; do
  if exempt "$doc" header "$doc"; then ok "$doc (header exempt)"; continue; fi
  if ! parse_header "$doc"; then
    bad "$doc has no self-declaring header in its first 12 lines (see tools/docs_gate.sh)"
    continue
  fi
  case "$HK" in
    state|reference|plan|guide) ;;
    *) bad "$doc: Kind is \`$HK\`; it must be one of state·reference·plan·guide" ;;
  esac
  printf '%s' "$HS" | grep -qE '^(current|stale — unverified since [0-9]{4}-[0-9]{2}-[0-9]{2}|superseded by .+)$' \
    || bad "$doc: Status is \`$HS\`; it must be \`current\`, \`stale — unverified since <date>\` or \`superseded by <path>\`"
  [ -n "$HO" ] || bad "$doc: the header has no \`Owns:\` — one line saying which question this doc answers"

  age="$(days_since "$HD")" \
    || { bad "$doc: \`Last verified: $HD\` is not a YYYY-MM-DD date"; continue; }
  if [ "$HS" = current ] && [ "$age" -gt "$stale_days" ]; then
    bad "$doc claims \`current\` but was last verified $age days ago — re-check it and move the date, or say \`stale — unverified since $HD\`"
  fi

  budget=0
  case "$HK" in plan) budget=$plan_budget ;; reference) budget=$ref_budget ;; esac
  if [ "$budget" -gt 0 ] && ! exempt "$doc" budget "$doc"; then
    lines="$(wc -l < "$doc")"
    if [ "$lines" -gt "$budget" ]; then
      msg="$doc is $lines lines against a $HK budget of $budget — split it, or move the dated narrative to HANDOFF"
      if [ "$budget_mode" = fail ]; then bad "$msg"; else warn "$msg"; fi
    fi
  fi
  ok "$doc ($HK, $HS)"
done < <(docset)

echo
[ "$warns" -eq 0 ] || echo "  ($warns budget warning(s); DOCS_GATE_BUDGETS=fail makes them fail)"
if [ "$fail" -ne 0 ]; then
  echo "  FAIL: the docs gate"
  exit 1
fi
echo "  DOCS GATE PASSES ($(docset | wc -l) docs)"
