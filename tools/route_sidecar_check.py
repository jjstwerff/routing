#!/usr/bin/env python3
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
"""PLAN-LAYERS §3 (L1) — the route sidecar carries ROUTES, and an old reader still sees the old file.

Two halves, and the second is the one that lets this land before the block regeneration:

  THE ROUTE TABLE — kind, level, node-network flag, colour, ref and name come out of the relation tags
    correctly, including osmium's `%xx%` escaping (a name with a space, a name with a comma), the
    `osmc:symbol` waycolour, the `colour` fallback, and a `route=` value we do not carry (ignored, not
    guessed at). One way is on two routes, which is the case a per-way bitmask cannot express and the
    whole reason the table exists.

  LEGACY COMPATIBILITY — `gen-tiles.loft`'s `load_networks` takes the text before the first SPACE as a
    way id and skips a line without one. This re-implements that reader EXACTLY and asserts it produces
    the old file's meaning from the new file: same ways, same three bits. A sidecar that quietly read as
    zero network bits would leave every other gate green (`network_gate.sh` only sees the block that
    comes later), which is precisely the shape this repo keeps paying for.

    tools/route_sidecar_check.py [<fixture.opl>]
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
fails = []


def ok(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond:
        fails.append(msg)


def legacy_reader(path):
    """gen-tiles.loft's `load_networks`, line for line — the reader we must not break."""
    out = {}
    for ln in path.read_text(encoding="utf-8").splitlines():
        if ln == "":
            continue
        sp = ln.find(" ")
        if sp <= 0:
            continue                      # `sp <= 0 { continue }` — no space at all, or a leading one
        try:
            wid, mask = int(ln[:sp]), int(ln[sp + 1:])
        except ValueError:
            continue                      # `as integer ?? 0` then the `wid > 0 && mask > 0` guard
        if wid > 0 and mask > 0:
            out[wid] = mask
    return out


def main() -> int:
    opl = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "fixtures" / "route_relations.opl"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/route_sidecar_check.networks")
    if not opl.exists():
        print(f"SKIP: no fixture at {opl}")
        return 2

    run = subprocess.run([sys.executable, str(HERE / "route_networks.py"), "--opl", str(opl), str(out)],
                         capture_output=True, text=True)
    if run.returncode != 0:
        print(run.stdout + run.stderr)
        print("FAIL: route_networks.py --opl did not run")
        return 1
    report = run.stdout
    print("".join("  | " + l + "\n" for l in report.strip().splitlines()))

    lines = out.read_text(encoding="utf-8").splitlines()
    routes = {int(l.split("\t")[1]): l.split("\t")[1:] for l in lines if l.startswith("R\t")}
    members = {int(l.split("\t")[1]): l.split("\t")[2] for l in lines if l.startswith("M\t")}

    # --- the route table ---------------------------------------------------------------------------
    ok(len(routes) == 7, f"7 route relations kept, the railway one ignored (got {len(routes)})")
    ok(routes.get(100) == ["100", "walk", "2", "0", "red", "LAW 9", "Pieterpad Noord"],
       f"a national hiking route keeps its osmc colour, ref and unescaped name: {routes.get(100)}")
    ok(routes.get(101) == ["101", "walk", "1", "1", "", "12-34", ""],
       f"a knooppunt segment is flagged node_network and identified by its ref: {routes.get(101)}")
    ok(routes.get(103) == ["103", "mtb", "0", "0", "blue", "", ""],
       f"`colour` is the fallback when there is no osmc:symbol, and no network= means level 0: {routes.get(103)}")
    ok(routes.get(104) and routes[104][1] == "horse" and routes[104][2] == "1",
       "a horse route is carried, at the level its rhn network declares")
    ok(routes.get(105) and routes[105][1] == "skate", "and inline skating, which nothing read before")
    ok(routes.get(107) and routes[107][6] == "Ronde, kort",
       f"a comma inside a name survives split-then-unescape: {routes.get(107, [''] * 7)[6]!r}")
    ok(106 not in routes, "a route= value we do not carry is ignored, not guessed at")

    # --- the membership fan-out --------------------------------------------------------------------
    ok(members.get(1) == "100,107", f"a way on TWO routes lists both (w1 → {members.get(1)})")
    ok(members.get(5) == "102,103", f"…and so does one on a cycle route and an MTB route (w5 → {members.get(5)})")
    ok(8 not in members, "a way that only the ignored relation held is absent")

    # --- legacy compatibility ----------------------------------------------------------------------
    legacy = legacy_reader(out)
    want = {1: 1 | 2, 2: 1, 3: 1, 4: 1 | 2, 5: 2 | 4, 6: 8, 7: 16}
    ok(legacy == want, f"the OLD loft reader gets exactly the old file's meaning from the new one: {legacy}")
    ok(all(not str(w).startswith(("R", "M")) for w in legacy),
       "…and reads none of the new records as a way id")

    print("PASS — the sidecar carries routes, and the reader that has not been taught about them is unharmed"
          if not fails else f"FAIL — {len(fails)} sidecar check(s) failed")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
