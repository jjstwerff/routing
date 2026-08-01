#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Run a long job in the background and wait for it WITHOUT a wait loop that can hang.
#
# WHY THIS EXISTS. The obvious way to wait for a background job is
#
#     until ! pgrep -f "my-long-build"; do sleep 60; done
#
# and it does not work: the waiting shell's own command line CONTAINS the pattern, so `pgrep` matches
# the waiter itself, the condition is never false, and the loop spins until the session ends. It fails
# in the direction that looks like "still running", so the job finishes and nobody notices — a country
# base map sat built and unexamined for ten minutes exactly this way (2026-08-01).
#
# So this waits on a FILE that the job itself writes when it exits. A file cannot match a pattern, a
# finished job cannot be mistaken for a running one, and the exit status survives — which `pgrep` never
# carried anyway. There is also a hard timeout, so the worst case is a wrong answer, never a hang.
#
#   tools/bg.sh start <name> <command…>   run in the background; log → scratch/bg/<name>.log
#   tools/bg.sh wait  <name> [timeout_s]  block until it exits (default 7200s); prints the tail
#   tools/bg.sh check <name>              one line: running / done rc=N; never blocks
#   tools/bg.sh log   <name> [lines]      show the log so far
#
# `wait` exits with the JOB's status, so `tools/bg.sh start b make x && tools/bg.sh wait b` behaves like
# running it in the foreground — but the shell is free in between.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="$here/scratch/bg"
mkdir -p "$dir"

name="${2:-}"
[ -n "$name" ] || { echo "usage: tools/bg.sh {start|wait|check|log} <name> [...]"; exit 2; }
log="$dir/$name.log"
done_file="$dir/$name.done"

case "${1:-}" in
  start)
    shift 2
    [ $# -gt 0 ] || { echo "usage: tools/bg.sh start <name> <command…>"; exit 2; }
    rm -f "$done_file"
    # The `.done` file is written by the SAME subshell that runs the command, so it cannot be skipped by
    # the job failing, crashing or being killed — which is what makes waiting on it safe.
    ( "$@" >"$log" 2>&1; echo $? > "$done_file" ) &
    echo "started '$name' (pid $!) → $log"
    ;;
  wait)
    timeout="${3:-7200}"
    waited=0
    while [ ! -f "$done_file" ]; do
      sleep 2
      waited=$((waited + 2))
      if [ "$waited" -ge "$timeout" ]; then
        echo "TIMEOUT after ${timeout}s — '$name' is still running (tools/bg.sh log $name)"
        exit 124
      fi
    done
    rc="$(cat "$done_file")"
    echo "== '$name' finished rc=$rc after ~${waited}s =="
    tail -15 "$log"
    exit "$rc"
    ;;
  check)
    if [ -f "$done_file" ]; then echo "$name: done rc=$(cat "$done_file")"
    else echo "$name: running ($(wc -l <"$log" 2>/dev/null || echo 0) log lines)"; fi
    ;;
  log)
    tail -"${3:-40}" "$log"
    ;;
  *)
    echo "usage: tools/bg.sh {start|wait|check|log} <name> [...]"; exit 2 ;;
esac
