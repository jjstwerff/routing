#!/usr/bin/env python3
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Which ways belong to a signposted route — and WHICH route, with its own name and colour.

PLAN-LAYERS §3 (L1), extending PLAN-RESTORE R3. OSM models these as RELATIONS over ways — a route
relation is a membership list, not a geometry — so `osmium export` cannot emit them at all (verified: it
produces nothing for `r/route`). The join has to be done here: read the relations, walk their member way
ids, and write both halves of what the map needs.

⚠ A COLOUR AND A NAME CANNOT LIVE ON THE WAY, and that is why this file grew a second table. They are
properties of the ROUTE — the Pieterpad has one name along all 500 km of it — and a way carries SEVERAL
routes at once. A per-way summary can say THAT a way is in a walking network; it can never say WHICH,
and "which" is exactly what a colour and a name are.

Output — three line kinds, and the LEGACY one is unchanged on purpose:

    R<TAB>rid<TAB>kind<TAB>level<TAB>flags<TAB>colour<TAB>ref<TAB>name    one per relation
    <wayid> <mask>                                                        LEGACY, one per way
    M<TAB>wayid<TAB>rid,rid,…                                             one per way

`kind` is our own vocabulary (walk/cycle/mtb/horse/skate), not the raw `route=` value, because `hiking`
and `foot` mean the same thing to a walker. `level` is 3=international 2=national 1=regional 0=local or
unknown, read from the first letter of `network=` (iwn/ncn/rwn/lcn… — the same letter across every mode).
`flags` bit 1 = `network:type=node_network`, the Dutch *knooppunten*, whose identity is a junction NUMBER
in `ref` rather than a name.

⚠ THE LEGACY LINE FORMAT IS PRESERVED EXACTLY, and the two new kinds are prefixed + TAB-separated so
they contain no space at all. `gen-tiles.loft`'s reader takes the text before the first SPACE as a way id
and skips a line that has none — so an old reader consuming a new sidecar sees precisely the file it saw
before, rather than reading it as zero network bits. That is what lets this land ahead of the block
regeneration that consumes the rest.

    tools/route_networks.py <region.osm.pbf> <out.networks>
    tools/route_networks.py --opl <relations.opl> <out.networks>   # the gate's entry point

`--opl` skips both osmium passes and reads their OUTPUT from a file. It exists so the parsing half — the
escaping, the level letter, `osmc:symbol`, the membership fan-out — is testable from a fixture of a few
hundred bytes, on a machine with no osmium and no 1.4 GB extract. The country-sized path is the same code
below it, so the fixture tests the thing that ships rather than a copy of it.
"""
import re
import subprocess
import sys
from collections import Counter

WALK, CYCLE, MTB, HORSE, SKATE = 1, 2, 4, 8, 16

# route=* → our kind. `foot` is rarer than `hiking` and means the same thing for our purposes;
# `running` is deliberately absent — those relations are events, not signposted infrastructure.
ROUTE_KIND = {
    "hiking": "walk", "foot": "walk",
    "bicycle": "cycle", "mtb": "mtb",
    "horse": "horse", "inline_skates": "skate",
}
KIND_BIT = {"walk": WALK, "cycle": CYCLE, "mtb": MTB, "horse": HORSE, "skate": SKATE}
# The OSM `network=` prefixes are per-mode (iwn/nwn/rwn/lwn for walking, icn/ncn/rcn/lcn for cycling,
# ihn/… for horse) but the FIRST letter is the level in every one of them.
LEVEL_LETTER = {"i": 3, "n": 2, "r": 1, "l": 0}
LEVEL_NAME = {3: "international", 2: "national", 1: "regional", 0: "local/unknown"}

# osmium's OPL escapes a special character as %<hex>% — a space is `%20%`. Values are split on `,` and
# `=` FIRST and unescaped after, because a comma inside a value arrives escaped.
_ESC = re.compile(r"%([0-9a-fA-F]{1,6})%")


def unescape(s):
    return _ESC.sub(lambda m: chr(int(m.group(1), 16)), s)


def colour_of(tags):
    """The paint on the tree, as a route is actually followed.

    `osmc:symbol` is `waycolour:background:foreground:text:textcolour`; the first field is the colour of
    the mark on the way, which is the one a walker matches against. `colour`/`color` are the fallback.
    """
    osmc = tags.get("osmc:symbol", "")
    if osmc:
        first = osmc.split(":", 1)[0].strip()
        if first:
            return first
    return (tags.get("colour") or tags.get("color") or "").strip()


def clean(s):
    """A single line, single field: tabs and newlines cannot survive in a TAB-separated record."""
    return s.replace("\t", " ").replace("\n", " ").replace("\r", " ").strip()


def main() -> int:
    args = sys.argv[1:]
    from_opl = args and args[0] == "--opl"
    if from_opl:
        args = args[1:]
    if len(args) < 2:
        print(__doc__.strip())
        return 2
    src, out = args[0], args[1]

    if from_opl:
        with open(src, "rb") as fh:
            opl_text = fh.read()
    else:
        # Two osmium passes: select the route relations, then render them as OPL so the members are
        # readable. `-f opl` is piped rather than written so a country run needs no intermediate file.
        sel = subprocess.run(
            ["osmium", "tags-filter", "-o", "-", "-f", "pbf", src,
             "r/route=" + ",".join(sorted(ROUTE_KIND))],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
        if sel.returncode != 0 or not sel.stdout:
            print(f"FAIL: osmium tags-filter produced nothing from {src}", file=sys.stderr)
            return 1
        # `-F pbf` is required: reading from stdin there is no filename to infer the format from.
        proc = subprocess.run(["osmium", "cat", "-F", "pbf", "-f", "opl", "-"], input=sel.stdout,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
        if proc.returncode != 0:
            print("FAIL: osmium cat -f opl", file=sys.stderr)
            return 1
        opl_text = proc.stdout

    routes = []                # (rid, kind, level, flags, colour, ref, name)
    ways = {}                  # way id → mask, the legacy half
    members = {}               # way id → the routes it is on
    kinds = Counter()
    levels = Counter()
    have = Counter()
    per_bit = Counter()

    for line in opl_text.decode("utf-8", "replace").splitlines():
        if not line.startswith("r"):
            continue
        head = line[1:].split(" ", 1)[0]
        rid = int(head) if head.isdigit() else 0
        tags, member_ids = {}, []
        for part in line.split(" "):
            if part.startswith("T"):
                for kv in part[1:].split(","):
                    if "=" in kv:
                        k, v = kv.split("=", 1)
                        tags[unescape(k)] = unescape(v)
            elif part.startswith("M"):
                member_ids = [m for m in part[1:].split(",") if m.startswith("w")]
        kind = ROUTE_KIND.get(tags.get("route", ""))
        if kind is None or rid <= 0:
            continue
        bit = KIND_BIT[kind]
        level = LEVEL_LETTER.get((tags.get("network", "") or " ")[0], 0)
        flags = 1 if tags.get("network:type") == "node_network" else 0
        colour, ref, name = colour_of(tags), clean(tags.get("ref", "")), clean(tags.get("name", ""))
        routes.append((rid, kind, level, flags, colour, ref, name))
        kinds[kind] += 1
        levels[level] += 1
        for key, val in (("ref", ref), ("name", name), ("colour", colour)):
            if val:
                have[key] += 1
        if flags & 1:
            have["node_network"] += 1
        for m in member_ids:
            wid_txt = m[1:].split("@")[0]
            if not wid_txt.isdigit():
                continue
            wid = int(wid_txt)
            ways[wid] = ways.get(wid, 0) | bit
            members.setdefault(wid, []).append(rid)

    with open(out, "w", encoding="utf-8") as fh:
        fh.write(f"# route_networks v2 — {len(routes)} relations, {len(ways)} ways\n")
        for rid, kind, level, flags, colour, ref, name in sorted(routes):
            fh.write(f"R\t{rid}\t{kind}\t{level}\t{flags}\t{colour}\t{ref}\t{name}\n")
        for wid in sorted(ways):
            fh.write(f"{wid} {ways[wid]}\n")                              # LEGACY — do not change
            fh.write("M\t{}\t{}\n".format(wid, ",".join(str(r) for r in members[wid])))

    # Counted per bit, not just per way: a category silently at zero is how every data loss in this
    # pipeline has looked, and the conservation gate can only check what something reports.
    for mask in ways.values():
        for kind, bit in KIND_BIT.items():
            if mask & bit:
                per_bit[kind] += 1
    memberships = sum(len(v) for v in members.values())
    widest = max((len(v) for v in members.values()), default=0)
    print(f"  networks: {len(routes)} relations "
          f"({', '.join(f'{k}={v}' for k, v in sorted(kinds.items()))}) "
          f"→ {len(ways)} ways ({' '.join(f'{k}={per_bit[k]}' for k in sorted(per_bit))})")
    print(f"  levels: {', '.join(f'{LEVEL_NAME[k]}={levels[k]}' for k in sorted(levels, reverse=True))}")
    print(f"  identity: ref={have['ref']} name={have['name']} colour={have['colour']} "
          f"node_network={have['node_network']}")
    print(f"  memberships: {memberships} over {len(ways)} ways "
          f"(mean {memberships / max(1, len(ways)):.2f}, widest {widest})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
