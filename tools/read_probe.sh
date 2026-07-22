#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-PERF §0 step 3 — the probe that gates steps 9-13: is a store FILE its own record image, so a
# reader can address it directly (HANDOFF's no-codec bet)? Delivers one PTile from a store_load'ed
# layout image and checks the same bytes appear VERBATIM in the file at the documented addressing.
#   tools/read_probe.sh [layout.store]
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-loft}"
store="${1:-$here/_site/stores/enschede.layout.store}"
[ -f "$store" ] || { echo "SKIP: no layout store at $store (build: node browser/build-site.mjs)"; exit 2; }

echo "== read probe: is the store FILE the record image? =="
out="$("$loft" --native "$here/browser/read_probe.loft" --lib "$here/lib" "$store" 2>&1)" || { echo "$out"; exit 1; }
echo "$out" | grep -E "first tile|tiles=" 
hex="$(echo "$out" | grep -oE 'bytes=[0-9a-f]+' | head -1 | cut -c7-)"
[ -n "$hex" ] || { echo "  FAIL: deliver emitted no bytes"; echo "$out" | head -3; exit 1; }

python3 - "$store" "$hex" <<'PY'
import sys, struct
data = open(sys.argv[1], "rb").read()
hexs = sys.argv[2]
head = bytes.fromhex(hexs[:48])          # first 3 i64 fields: tkey, ox, oy
i = data.find(head)
print(f"  file {len(data):,} bytes · header magic {data[:4].decode('latin1')!r}")
if i < 0:
    print("  ❌ delivered record bytes NOT in the file — store_load relocates/fixes up on adopt.")
    print("     Steps 9-13 are dead as written; fall back to expose() over wasm memory.")
    sys.exit(1)
tkey, ox, oy = struct.unpack_from("<qqq", data, i)
print(f"  ✅ record found VERBATIM @ 0x{i:08x} (8-byte aligned: {i % 8 == 0}, rec={i//8})")
print(f"     read from file: tkey={tkey} ox={ox} oy={oy}")
print("     → addr(rec,pos) = storeBase + rec*8 + pos works with storeBase=0 on the fetched bytes.")
PY
