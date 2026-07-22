#!/usr/bin/env bash
# PLAN-BASEMAP S0 — the isolation gate (the design's falsifier). The presentation layer must be strictly
# additive: the routing kernel's output stays byte-identical and its input-path sources stay frozen. This
# is re-run after every basemap step; the first step that reddens it has violated the invariant.
#
# Two checks:
#   1. The matcher's route on the reference dataset is byte-identical to tools/basemap/routing_ref.txt.
#   2. The frozen sources (matcher + browser input path + reference generator) are unchanged
#      (tools/basemap/frozen.sha256) — so nothing here started feeding presentation bytes to the kernel.
#
# If a LEGITIMATE (non-basemap) routing change alters these, regenerate the baselines on purpose:
#   loft --interpret --path <loft>/ --lib lib client/app_kernel.loft <ref-data> > tools/basemap/routing_ref.txt
#   sha256sum <the three files> > tools/basemap/frozen.sha256
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft)}"
# The dir containing default/ (the stdlib the --native-wasm build compiles against). Default to the
# INSTALLED loft's stdlib, NOT ../loft: that sibling tree is another agent's live workspace, and a
# mid-edit default/01_code.loft there fails this gate with errors that have nothing to do with routing
# (seen 2026-07-16: "Unknown function sum at ../loft/default/01_code.loft:1495"). Override with
# LOFT_ROOT only to test an unreleased stdlib on purpose.
loftroot="${LOFT_ROOT:-$(dirname "$(dirname "$(command -v loft 2>/dev/null || echo /usr/local/bin/loft)")")/share/loft}"
[ -d "$loftroot/default" ] || loftroot="$here/../loft"   # fallback: a source checkout
data="${1:-$here/lib/routing_kernel/tests/fixtures/real_stretch.json}"
ref="$here/tools/basemap/routing_ref.txt"
frozen="$here/tools/basemap/frozen.sha256"

[ -x "$loft" ] || { echo "SKIP: loft not found at $loft (set LOFT_BIN)"; exit 2; }
ok=1

# 1. Routing output frozen (the invariant: presentation work must not change the matcher's route).
got="$("$loft" --interpret --path "$loftroot/" --lib "$here/lib" "$here/client/app_kernel.loft" "$data" 2>/dev/null)"
if [ "$got" = "$(cat "$ref")" ]; then
  echo "  PASS routing output byte-identical ($(sed -n 1p "$ref"))"
else
  echo "  FAIL routing output CHANGED — the matcher is not isolated from basemap work:"; diff <(echo "$got") "$ref" | head; ok=0
fi

# 2. Input-path sources frozen (the N=1 re-assertion site: web_kernel must stay roads-only).
if ( cd "$here" && sha256sum -c --quiet "$frozen" ) 2>/dev/null; then
  echo "  PASS frozen sources unchanged (matcher + web_kernel input path)"
else
  echo "  FAIL a frozen source changed — basemap work touched the routing input path:"; ( cd "$here" && sha256sum -c "$frozen" 2>&1 | grep -v ': OK$' ); ok=0
fi

# 3. Structural isolation (PLAN-BASEMAP S5.6): the two subsystems share NO code. Routing never imports the
#    presentation lib; the presentation lib never imports the frozen routing kernel (it reimplements the
#    grid); and the routing kernel carries no presentation record types. So they can only ever share
#    coordinates + a snapshot date — never a store, a struct, or a function.
si=1
grep -rqE 'use[[:space:]]+basemap' "$here/lib/routing_kernel/src" 2>/dev/null && { echo "  FAIL routing_kernel imports basemap"; si=0; }
grep -rqE 'use[[:space:]]+routing_kernel' "$here/lib/basemap/src" 2>/dev/null && { echo "  FAIL basemap imports routing_kernel"; si=0; }
grep -rqE '\b(PTile|area_use|struct (Area|Building|Poi|Label))\b' "$here/lib/routing_kernel/src" 2>/dev/null && { echo "  FAIL presentation types leaked into routing_kernel"; si=0; }
[ "$si" = 1 ] && echo "  PASS structural isolation (no shared code; routing carries no presentation types)" || ok=0

[ "$ok" = 1 ] && echo "PASS — routing is isolated from the presentation layer, runtime AND structurally (PLAN-BASEMAP S0/S5.6)." || { echo "FAILURES — isolation invariant violated."; exit 1; }
