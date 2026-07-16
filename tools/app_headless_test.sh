#!/usr/bin/env bash
# Headless proof (PLAN-APP Track 1, step 1): the FULL matcher — parse_ways -> build_graph ->
# match_route over a WHOLE test-set loaded directly (one Overpass-JSON file) — runs
# BYTE-IDENTICALLY on --interpret, --native, and --native-wasm (WASI via wasmtime). This is the
# compute+data core the browser app runs; proven before the working-set partial-load (loft#522)
# lands. No mmap store, no codec: parse_ways over a text blob is pure and wasm-safe.
#
# Complements tools/kernel_headless_test.sh (which only proves the geodesic). Here the whole
# escalation matcher runs in wasm on a real 151 KB corridor and the detailed route is byte-equal
# across all three backends — the route coords are parsed data, and path costs differ by metres
# (far above the ~1e-6 m geodesic ULP noise), so the discrete choice never flips.
#
# Exits 0 iff interpret == native == native-wasm output, byte-for-byte.
# Requires: the loft toolchain (../loft by default, or $LOFT_BIN) and wasmtime on PATH.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"      # routing repo root
# The dir containing default/ (the stdlib the --native-wasm build compiles against). Default to the
# INSTALLED loft's stdlib, NOT ../loft: that sibling tree is another agent's live workspace, and a
# mid-edit default/01_code.loft there fails this gate with errors that have nothing to do with routing
# (seen 2026-07-16: "Unknown function sum at ../loft/default/01_code.loft:1495"). Override with
# LOFT_ROOT only to test an unreleased stdlib on purpose.
loftroot="${LOFT_ROOT:-$(dirname "$(dirname "$(command -v loft 2>/dev/null || echo /usr/local/bin/loft)")")/share/loft}"
[ -d "$loftroot/default" ] || loftroot="$here/../loft"   # fallback: a source checkout
loft="${LOFT_BIN:-$loftroot/target/release/loft}"
lib="$here/lib"
client="$here/client/app_kernel.loft"
data="lib/routing_kernel/tests/fixtures/real_stretch.json"  # repo-root-relative (#cwd entry)
tmp="$(mktemp -d)"; wasm="$tmp/app.wasm"

command -v wasmtime >/dev/null || { echo "SKIP: wasmtime not found on PATH"; exit 2; }
[ -x "$loft" ] || { echo "SKIP: loft binary not found at $loft (set LOFT_BIN)"; exit 2; }

cd "$here"
echo "building client/app_kernel.loft --native-wasm (wasip2)..."
LOFT_TIMEOUT=300 "$loft" --native-wasm "$wasm" --path "$loftroot/" --lib "$lib" "$client" >/dev/null 2>&1

# stderr dropped: the kernel carries one pre-existing elevation warning that is not this gate's concern.
i="$("$loft" --interpret --path "$loftroot/" --lib "$lib" "$client" "$data" 2>/dev/null)"
n="$("$loft" --native    --path "$loftroot/" --lib "$lib" "$client" "$data" 2>/dev/null)"
w="$(wasmtime --dir . "$wasm" "$data" 2>/dev/null)"

fail=0
[ -n "$i" ] || { echo "FAIL: interpret produced no output"; fail=1; }
[ "$i" = "$n" ] || { echo "FAIL: interpret != native"; fail=1; }
[ "$i" = "$w" ] || { echo "FAIL: interpret != native-wasm"; fail=1; }

if [ "$fail" -eq 0 ]; then
  echo "$i" | head -1
  echo "ALL PASS — full matcher interpret == native == native-wasm, byte-identical (whole-file test set)."
else
  echo "--- interpret ---"; printf '%s\n' "$i" | head -2
  echo "--- native ---";    printf '%s\n' "$n" | head -2
  echo "--- wasm ---";      printf '%s\n' "$w" | head -2
  exit 1
fi
