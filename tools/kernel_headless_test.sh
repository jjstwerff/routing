#!/usr/bin/env bash
# Headless proof for PLAN step 4 (candidate a): the pure-loft routing_kernel computes route
# length IDENTICALLY on --interpret and --native-wasm (WASI, run via wasmtime), driven with the
# points as a plain WASI argument — a shipped, generic channel, NO custom bridge.
#
# Exits 0 iff, for every case: interpret output == wasm output (byte-for-byte parity) AND the
# value is within TOL metres of the independently-known distance.
#
# Requires: the loft toolchain (../loft by default, or $LOFT_BIN) and wasmtime on PATH.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"      # routing repo root
loftroot="${LOFT_ROOT:-$here/../loft}"                       # dir containing default/
loft="${LOFT_BIN:-$loftroot/target/release/loft}"
lib="$here/lib"
client="$here/client/kernel.loft"
wasm="$(mktemp -d)/kernel.wasm"
TOL=1.0   # metres

command -v wasmtime >/dev/null || { echo "SKIP: wasmtime not found on PATH"; exit 2; }
[ -x "$loft" ] || { echo "SKIP: loft binary not found at $loft (set LOFT_BIN)"; exit 2; }

echo "building client/kernel.loft --native-wasm (wasip2)..."
LOFT_TIMEOUT=300 "$loft" --native-wasm "$wasm" --path "$loftroot/" --lib "$lib" "$client" >/dev/null 2>&1

fail=0
check() { # name  input  expected_metres
  local name="$1" input="$2" exp="$3" i w
  i="$("$loft" --interpret --path "$loftroot/" --lib "$lib" "$client" "$input" 2>/dev/null)"
  w="$(wasmtime run "$wasm" "$input" 2>/dev/null)"
  if [ "$i" != "$w" ]; then
    echo "FAIL $name: interpret($i) != wasm($w)"; fail=1; return
  fi
  if awk -v g="$w" -v e="$exp" -v t="$TOL" 'BEGIN{d=g-e; if(d<0)d=-d; exit !(d<=t)}'; then
    echo "PASS $name: $w m  (interpret==wasm, exp ~$exp)"
  else
    echo "FAIL $name: got $w, expected ~$exp (±$TOL)"; fail=1
  fi
}

check "single-1km"    "52.0,5.0;52.009,5.0"              1000.756
check "two-segments"  "52.0,5.0;52.009,5.0;52.018,5.0"   2001.511
check "equator-0.01"  "0,0;0,0.01"                        1112.0
check "one-point"     "52.0,5.0"                          0.0

if [ "$fail" -eq 0 ]; then
  echo "ALL PASS — interpret == native-wasm within ${TOL} m, no custom bridge."
else
  echo "FAILURES"; exit 1
fi
