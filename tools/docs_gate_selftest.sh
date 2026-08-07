#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# DOES THE DOCS GATE ACTUALLY CATCH ANYTHING?
#
# `tools/docs_gate.sh` passes on this tree, and that is worth nothing on its own: a gate that has never
# been shown to FAIL is a gate nobody knows the reach of. `docs/doc-structure-design.md` §5 claims rule
# 1 "would have caught all five missing files" — this is where that stops being a claim.
#
# It builds a throwaway repo per case, injects EXACTLY ONE defect, and asserts the gate's verdict. Two
# of the cases are the ones most likely to rot into a false sense of safety:
#
#   * age-alone-passes — rule 4 must NOT fail an old doc that honestly says `stale`. If it ever does,
#     people will date-stamp docs they have not re-read just to get green, and the field dies.
#   * substring — the root `README.md` must not count as indexed because §4 names `plans/README.md`.
#     That bug was live in the first version of the gate and it silently exempts the front page.
#
#   tools/docs_gate_selftest.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gate="$here/tools/docs_gate.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail=0
ok()  { printf '  \342\234\223 %s\n' "$1"; }
bad() { printf '  FAIL: %s\n' "$1"; fail=1; }

# --- a minimal well-formed repo ---------------------------------------------------------------------
# doc <path> <kind> <status> <last-verified> [extra body line]
doc() {
  mkdir -p "$(dirname "$repo/$1")"
  { printf '# %s\n\n' "$(basename "$1" .md)"
    printf '**Kind:** %s · **Status:** %s · **Last verified:** %s · **Owns:** a test fixture\n\n' "$2" "$3" "$4"
    [ $# -ge 5 ] && printf '%s\n' "$5"
  } > "$repo/$1"
}
index() { # index <path>... — write HANDOFF.md with a §4 naming exactly these paths
  { printf '# HANDOFF\n\n'
    printf '**Kind:** state · **Status:** current · **Last verified:** 2026-08-07 · **Owns:** the index\n\n'
    printf '## 4. Where the docs are\n\n'
    for p in "$@"; do printf -- '- `%s`\n' "$p"; done
    printf '\n## 5. After\n'
  } > "$repo/HANDOFF.md"
}
newrepo() {
  repo="$work/$1"; rm -rf "$repo"; mkdir -p "$repo/tools"
  cp "$gate" "$repo/tools/docs_gate.sh"
  : > "$repo/tools/docs_gate.exempt"
  git -C "$repo" init -q 2>/dev/null
}
verdict() { # verdict <case> <expect: pass|fail> [env assignments...]
  local name="$1" expect="$2"; shift 2
  git -C "$repo" add -A 2>/dev/null
  local out rc
  out="$(cd "$repo" && env DOCS_GATE_TODAY=2026-08-07 "$@" ./tools/docs_gate.sh 2>&1)"; rc=$?
  local got=pass; [ "$rc" -eq 0 ] || got=fail
  if [ "$got" = "$expect" ]; then
    ok "$name — gate $got, as expected"
  else
    bad "$name — gate $got, expected $expect"
    printf '%s\n' "$out" | sed 's/^/        /'
  fi
}

echo "== does the docs gate catch what it claims to? =="

newrepo baseline
doc DESIGN.md reference current 2026-08-01
index HANDOFF.md DESIGN.md
verdict "a clean tree" pass

newrepo orphan
doc DESIGN.md reference current 2026-08-01
doc PLAN-LOST.md reference current 2026-08-01
index HANDOFF.md DESIGN.md
verdict "rule 1: a doc missing from the index" fail

newrepo orphan-exempt
doc DESIGN.md reference current 2026-08-01
doc PLAN-LOST.md reference current 2026-08-01
index HANDOFF.md DESIGN.md
printf 'PLAN-LOST.md\torphan\t*\ttested on purpose\n' > "$repo/tools/docs_gate.exempt"
verdict "rule 1: ...unless the exempt manifest says why" pass

newrepo substring
doc plans/README.md guide current 2026-08-01
doc README.md reference current 2026-08-01
index HANDOFF.md plans/README.md
verdict "rule 1: 'plans/README.md' in the index does not index 'README.md'" fail

newrepo dangling
doc DESIGN.md reference current 2026-08-01 'see `PLAN-GHOST.md` for the rest'
index HANDOFF.md DESIGN.md
verdict "rule 2: a pointer at a file that is not there" fail

newrepo sibling
doc DESIGN.md reference current 2026-08-01 'the rule is in `../loft2/doc/claude/LOFT.md`, see also `WEB_APPS.md`'
index HANDOFF.md DESIGN.md
verdict "rule 2: another repo's docs are not ours to resolve" pass

newrepo noheader
printf '# Bare\n\nnothing declared here.\n' > "$repo/DESIGN.md"
index HANDOFF.md DESIGN.md
verdict "rule 3: a doc that declares nothing" fail

newrepo badkind
doc DESIGN.md notebook current 2026-08-01
index HANDOFF.md DESIGN.md
verdict "rule 3: a kind outside state·reference·plan·guide" fail

newrepo baddate
doc DESIGN.md reference current "last Tuesday"
index HANDOFF.md DESIGN.md
verdict "rule 3: a last-verified that is not a date" fail

newrepo silently-stale
doc DESIGN.md reference current 2026-01-01
index HANDOFF.md DESIGN.md
verdict "rule 4: 220 days old and still claiming 'current'" fail

newrepo honestly-stale
doc DESIGN.md reference 'stale — unverified since 2026-01-01' 2026-01-01
index HANDOFF.md DESIGN.md
verdict "rule 4: the SAME doc, saying so — age alone never fails" pass

newrepo superseded
doc DESIGN.md 'reference' 'superseded by docs/ARCHITECTURE.md' 2026-01-01
doc docs/ARCHITECTURE.md reference current 2026-08-01
index HANDOFF.md DESIGN.md docs/ARCHITECTURE.md
verdict "rule 4: 'superseded by' is an honest status too" pass

newrepo budget
doc DESIGN.md reference current 2026-08-01
for i in $(seq 1 900); do echo "line $i" >> "$repo/DESIGN.md"; done
index HANDOFF.md DESIGN.md
verdict "rule 5: 900 lines of reference — warns by default" pass
verdict "rule 5: ...and fails when switched on" fail DOCS_GATE_BUDGETS=fail

newrepo noindex
doc DESIGN.md reference current 2026-08-01
printf '# HANDOFF\n\n**Kind:** state · **Status:** current · **Last verified:** 2026-08-07 · **Owns:** x\n\nno section 4 here.\n' > "$repo/HANDOFF.md"
verdict "the index section itself going missing" fail

echo
[ "$fail" -eq 0 ] || { echo "  FAIL: the docs gate self-test"; exit 1; }
echo "  DOCS GATE SELF-TEST PASSES (14 cases)"
