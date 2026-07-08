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
loftroot="${LOFT_ROOT:-$here/../loft}"
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

[ "$ok" = 1 ] && echo "PASS — routing kernel is isolated from the presentation layer (PLAN-BASEMAP S0)." || { echo "FAILURES — isolation invariant violated."; exit 1; }
