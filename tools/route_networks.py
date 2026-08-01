#!/usr/bin/env python3
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Which ways belong to a signposted walking / cycling / MTB network.

PLAN-RESTORE R3, implementing PLAN-TILES §Future. OSM models these as RELATIONS over ways — a route
relation is a membership list, not a geometry — so `osmium export` cannot emit them at all (verified: it
produces nothing for `r/route`). The join has to be done here: read the relations, walk their member way
ids, and write one line per way.

Output: `<wayid> <mask>` per line, mask = 1 walking | 2 cycling | 4 MTB, OR-ed where a way carries more
than one. `tools/gen-tiles.loft` reads it and sets RF_NET_* on the stored way, which is what lets the
ROUTER prefer them — the old client could only show them as someone else's raster tiles.

    tools/route_networks.py <region.osm.pbf> <out.networks>

Needs osmium on PATH; uses OPL because it is the one output format that exposes relation members.
"""
import subprocess
import sys
from collections import Counter

WALK, CYCLE, MTB = 1, 2, 4

# route=* → which network bit. `foot` is rarer than `hiking` and means the same thing for our purposes;
# `running` is deliberately absent — those relations are events, not signposted infrastructure.
ROUTE_BIT = {"hiking": WALK, "foot": WALK, "bicycle": CYCLE, "mtb": MTB}


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__.strip())
        return 2
    src, out = sys.argv[1], sys.argv[2]

    # Two osmium passes: select the route relations, then render them as OPL so the members are readable.
    # `-f opl` is piped rather than written so a country-sized run needs no intermediate file.
    sel = subprocess.run(
        ["osmium", "tags-filter", "-o", "-", "-f", "pbf", src, "r/route=hiking,foot,bicycle,mtb"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    if sel.returncode != 0 or not sel.stdout:
        print(f"FAIL: osmium tags-filter produced nothing from {src}", file=sys.stderr)
        return 1
    # `-F pbf` is required: reading from stdin there is no filename for osmium to infer the format from.
    opl = subprocess.run(["osmium", "cat", "-F", "pbf", "-f", "opl", "-"], input=sel.stdout,
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    if opl.returncode != 0:
        print("FAIL: osmium cat -f opl", file=sys.stderr)
        return 1

    ways: dict[int, int] = {}
    rels = 0
    kinds: Counter[str] = Counter()
    for line in opl.stdout.decode("utf-8", "replace").splitlines():
        if not line.startswith("r"):
            continue
        tags, members = {}, []
        for part in line.split(" "):
            if part.startswith("T"):
                for kv in part[1:].split(","):
                    if "=" in kv:
                        k, v = kv.split("=", 1)
                        tags[k] = v
            elif part.startswith("M"):
                members = [m for m in part[1:].split(",") if m.startswith("w")]
        bit = ROUTE_BIT.get(tags.get("route", ""))
        if bit is None:
            continue
        rels += 1
        kinds[tags.get("route", "")] += 1
        for m in members:
            wid = m[1:].split("@")[0]
            if wid.isdigit():
                ways[int(wid)] = ways.get(int(wid), 0) | bit

    with open(out, "w", encoding="utf-8") as fh:
        for wid in sorted(ways):
            fh.write(f"{wid} {ways[wid]}\n")

    # Counted per bit, not just per way: a category silently at zero is how every data loss in this
    # pipeline has looked, and the conservation gate can only check what something reports.
    per = Counter()
    for mask in ways.values():
        if mask & WALK:
            per["walk"] += 1
        if mask & CYCLE:
            per["cycle"] += 1
        if mask & MTB:
            per["mtb"] += 1
    print(f"  networks: {rels} relations "
          f"({', '.join(f'{k}={v}' for k, v in sorted(kinds.items()))}) "
          f"→ {len(ways)} ways (walk={per['walk']} cycle={per['cycle']} mtb={per['mtb']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
