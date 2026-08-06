#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# RUN EVERY GATE, THEN REPORT — the CI half of `tools/gates.offline`.
#
# `make test` stops at the first failure, which is right when you are iterating: you broke one thing and
# want to know about that thing. CI is the opposite case. A red build that names gate 1 and hides gates
# 2-8 costs one full round trip (~5 min of toolchain build) per hidden failure, and it invites the fix
# that makes gate 1 pass and lands gate 5 broken.
#
# So: run all of them, keep going after a failure, and report
#   * per gate — pass/fail and DURATION, on the job log and in the run summary table
#   * the failing gates' output, replayed at the end so the reason is in front of you, not 400 lines up
# then exit non-zero if any failed.
#
# Usage: tools/ci_gates.sh [manifest]        (default tools/gates.offline)
set -uo pipefail
cd "$(dirname "$0")/.."

MANIFEST="${1:-tools/gates.offline}"
[ -r "$MANIFEST" ] || { echo "ERROR: no gate manifest at $MANIFEST"; exit 1; }

# Both consumers of the manifest export these; the kernel list stays a Makefile variable so there is
# still only one copy of it.
export LOFT_BIN="${LOFT_BIN:-${LOFT:-$(command -v loft)}}"
export KERNEL_TESTS="${KERNEL_TESTS:-$(make -s print-kernel-tests 2>/dev/null)}"
[ -x "$LOFT_BIN" ] || { echo "ERROR: loft not found (LOFT_BIN=$LOFT_BIN)"; exit 1; }

LOGDIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ci-gates.$$"
mkdir -p "$LOGDIR"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

names=() results=() times=()
failed=0 total=0

while IFS=$'\t' read -r name cmd; do
  case "$name" in ''|\#*) continue ;; esac
  [ -n "${cmd:-}" ] || continue
  total=$((total + 1))
  # ::group:: folds the gate's output in the Actions log — every gate's detail is one click away
  # instead of one 3000-line scroll. Harmless noise on a terminal.
  echo "::group::${name}"
  start=$(date +%s%3N)
  if bash -c "$cmd" >"$LOGDIR/$name.log" 2>&1; then
    ok=1
  else
    ok=0
    failed=$((failed + 1))
  fi
  ms=$(( $(date +%s%3N) - start ))
  cat "$LOGDIR/$name.log"
  echo "::endgroup::"
  if [ "$ok" = 1 ]; then
    printf '  \033[32mPASS\033[0m %-16s %6s ms\n' "$name" "$ms"
    results+=("PASS")
  else
    printf '  \033[31mFAIL\033[0m %-16s %6s ms\n' "$name" "$ms"
    results+=("FAIL")
    # An annotation puts the failing gate on the PR's Files/Checks view directly.
    echo "::error title=gate ${name} failed::see the '${name}' group in the job log"
  fi
  names+=("$name")
  times+=("$ms")
done < "$MANIFEST"

# --- the run summary table (GitHub renders this on the run's front page) --------------------------
{
  echo "### Offline gates — ${total} run, $((total - failed)) passed, ${failed} failed"
  echo
  echo "| gate | result | duration |"
  echo "|---|---|--:|"
  for i in "${!names[@]}"; do
    icon="✅"; [ "${results[$i]}" = FAIL ] && icon="❌"
    printf '| `%s` | %s %s | %s ms |\n' "${names[$i]}" "$icon" "${results[$i]}" "${times[$i]}"
  done
} >>"$SUMMARY"

echo
if [ "$failed" -gt 0 ]; then
  # Replay the failures LAST. The reason a build is red should be the final thing on the log, not
  # buried behind the gates that happened to run after it.
  echo "──────── ${failed} of ${total} gates FAILED ────────"
  for i in "${!names[@]}"; do
    [ "${results[$i]}" = FAIL ] || continue
    echo
    echo "── ${names[$i]} ── (last 40 lines)"
    tail -40 "$LOGDIR/${names[$i]}.log"
  done
  exit 1
fi
echo "  ALL ${total} OFFLINE GATES PASS"
