#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Does the deployed site still fit GitHub Pages? (PLAN-SCALE N3/D2.)
#
# Pages caps a published site at roughly 1 GB. That number is the only thing standing between the current
# layout and the one the project wants — the NL ROADS ship beside the app precisely because 497 MB fits
# and the 2874 MB base map does not — so it is a budget, not a footnote, and N3 says to MEASURE it in the
# build rather than assume it.
#
# It is computed from the INDEX plus the built site, not from `du _site`, for a reason: a PR runner does
# not download half a gigabyte of blocks, so `du` there would report a comfortable 27 MB for a site that
# would be 524 MB once deployed. The index records every block's byte count, which is the same number the
# deploy will ship, so the projection is exact and costs nothing.
#
#   tools/site_size_gate.sh [limit-mb]
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
idx="$here/browser/coverage.json"
# 950 of the ~1000 MB cap. The margin is not politeness: the cap is documented loosely, a rejected deploy
# is discovered only after a push, and the next region added is what will cross it.
limit_mb="${1:-950}"
[ -f "$idx" ] || { echo "SKIP: no browser/coverage.json"; exit 2; }
[ -d "$here/_site" ] || { echo "SKIP: no _site (run: node browser/build-site.mjs)"; exit 2; }

python3 - "$idx" "$here/_site" "$limit_mb" <<'PY'
import json, os, sys
idx, site, limit_mb = sys.argv[1], sys.argv[2], float(sys.argv[3])
d = json.load(open(idx))

# Every store named RELATIVELY is one this origin serves; an absolute url is hosted elsewhere and costs
# the site nothing. Deduplicated by filename: two regions may legitimately name the same store.
blocks, remote = {}, 0
for b in d.get("blocks", []):
    for st in (b.get("roads"), b.get("base"), b.get("names")):
        if not st or not st.get("url"):
            continue
        if "://" in st["url"]:
            remote += st.get("bytes", 0)
            continue
        blocks[st["url"].rsplit("/", 1)[-1]] = st.get("bytes", 0)

# The app itself: everything in _site that is NOT one of those blocks (they may or may not be present
# here, and either way the index's byte count is the number that ships).
shell = 0
for root, _, files in os.walk(site):
    for f in files:
        if f in blocks:
            continue
        shell += os.path.getsize(os.path.join(root, f))

data = sum(blocks.values())
total = shell + data
mb = lambda n: n / 1e6
print(f"  app shell + committed stores : {mb(shell):8.1f} MB")
for name, n in sorted(blocks.items(), key=lambda kv: -kv[1]):
    here_ = "present" if os.path.exists(os.path.join(site, "stores", name)) else "fetched at deploy"
    print(f"  {name:28s} : {mb(n):8.1f} MB  ({here_})")
print(f"  {'TOTAL DEPLOYED':28s} : {mb(total):8.1f} MB   of a {limit_mb:.0f} MB budget "
      f"({mb(total) / limit_mb * 100:.0f}%)")
if remote:
    print(f"  (plus {mb(remote):.1f} MB served from the release, which costs the site nothing)")

if mb(total) > limit_mb:
    print(f"FAIL — the deployed site would be {mb(total):.1f} MB, over the {limit_mb:.0f} MB budget.")
    print("       GitHub Pages caps a site around 1 GB and rejects the deploy AFTER the push. Move the")
    print("       largest block to the release (give its region a `base_url_base`/`url_base` in")
    print("       data/coverage.toml) or split the region further.")
    sys.exit(1)
print("PASS — the deployed site fits the Pages budget")
PY
