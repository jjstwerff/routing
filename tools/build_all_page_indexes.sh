#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Build the page index for EVERY store the coverage index names (docs/prefetch-index-design.md).
#
# Smallest first, so a failure shows up in seconds rather than after the 86 512-cell one. Each block gets
# its own port, so a stale server from a previous run cannot silently answer for the next.
#
#   tools/build_all_page_indexes.sh            # everything present in blocks/
#   PAGEIDX_JOBS=8 tools/build_all_page_indexes.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 - "$here" <<'PY' > /tmp/pageidx_plan.txt
import json, os, sys
here = sys.argv[1]
d = json.load(open(os.path.join(here, 'browser', 'coverage.json')))
rows = []
for b in d['blocks']:
    for k, kind in (('roads', 'TTile'), ('base', 'PTile')):
        s = b.get(k)
        if not s or not s.get('tiles'): continue
        name = s['url'].split('/')[-1]
        if os.path.isfile(os.path.join(here, 'blocks', name)):
            rows.append((s['tiles'], name, kind))
for t, n, k in sorted(set(rows)):
    print(f"{n} {k} {t}")
PY
total=$(awk '{s+=$3} END {print s}' /tmp/pageidx_plan.txt)
echo "== page indexes for $(wc -l < /tmp/pageidx_plan.txt) store(s), $total cells =="
port=8500; ok=0; fail=0
while read -r name kind cells; do
  out="$here/blocks/$name.pages.json"
  printf '\n-- %s (%s cells)\n' "$name" "$cells"
  if PAGEIDX_PORT=$port "$here/tools/build_page_index.sh" "$here/blocks/$name" "$kind" "$out" 2>&1 \
       | grep -E 'distinct pages|mean pages|whole STORE|index written|FAIL'; then ok=$((ok+1)); else fail=$((fail+1)); fi
  port=$((port+1))
done < /tmp/pageidx_plan.txt
echo
echo "== $ok built, $fail failed =="
du -ch "$here"/blocks/*.pages.json 2>/dev/null | tail -1 | sed 's/^/   total index size: /'
