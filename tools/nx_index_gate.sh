#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# THE TWO SPELLINGS OF THE SEARCH INDEX AGREE.
#
# The index's filenames are written down twice, on purpose and for different jobs:
#
#   the KERNEL derives them   `x.names.store` -> `x.nx{words,posts,ents}.store`
#                             (client/web_basemap_kernel.loft — it has only the names URL to go on)
#   the INDEX declares them   with a size and a sha256, because `fetch-site-blocks.sh` refuses to ship
#                             a file it cannot verify, and a hash cannot be derived
#
# ⚠ IF THOSE DISAGREE, NOTHING REPORTS IT. The deploy would ship files under one set of names and the app
# would fetch another, get a 404 on the vocabulary, mark the region un-indexed and fall back to reading
# the whole 21.4 MB names store — which is the behaviour that shipped for a year, so it looks like
# working software and not like a bug. This gate is the only thing standing between that and a release.
#
# It reads `browser/coverage.json` alone — no stores, no network — so unlike the parity gate it costs
# nothing and can run in CI.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "== the search index: the kernel's names and the index's names are the same names =="
python3 - browser/coverage.json <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
bad = 0; checked = 0; declared = 0; plain = 0
for b in d.get("blocks", []):
    nm = (b.get("names") or {}).get("url", "")
    se = b.get("search")
    if not se:
        plain += 1
        continue
    declared += 1
    base = nm.rsplit("/", 1)[-1]
    if not base.endswith(".names.store"):
        print(f"  FAIL: {b.get('id')} declares a search index but its names url is {nm!r}")
        bad += 1
        continue
    stem = base[: -len(".names.store")]
    for part in ("nxwords", "nxposts", "nxents"):
        st = se.get(part)
        if not st or not st.get("url"):
            print(f"  FAIL: {b.get('id')} search.{part} is missing — all three or none")
            bad += 1
            continue
        got = st["url"].rsplit("/", 1)[-1]
        want = f"{stem}.{part}.store"
        if got != want:
            print(f"  FAIL: {b.get('id')} search.{part} is {got!r}, the kernel will fetch {want!r}")
            bad += 1
        # A declared part with no hash cannot be verified on the way in, which is the whole reason it
        # is declared rather than derived.
        if not st.get("sha256") or not st.get("bytes"):
            print(f"  FAIL: {b.get('id')} search.{part} has no bytes/sha256 — a fetch could not verify it")
            bad += 1
        checked += 1
print(f"  {declared} block(s) declare a search index, {checked} name(s) checked, {plain} without one")
if plain and not declared:
    print("  (no block declares one yet — the app scans, which is the pre-index behaviour)")
sys.exit(1 if bad else 0)
PY
rc=$?
[ $rc -ne 0 ] && { echo "  FAIL: the deploy and the app disagree about what the index files are called"; exit 1; }
echo "  THE TWO SPELLINGS AGREE"
