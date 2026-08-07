<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Reproducers filed upstream

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-06 · **Owns:** the reproducers filed upstream, kept runnable here

Self-contained repros for two loft loader findings — **no routing data**: each builds its own store.
Filed on `loft-lang/loft`; kept here because a reproducer that only lives in an issue stops being run.

```bash
cd tools/loft_repro

# 1 — the ranges are issued ONE AT A TIME, though the loader is given every key up front.
loft --native make_store.loft repro.store 2000 500
LATENCY_MS=0  python3 ../range_server.py 8223 . /dev/null &   # then time it:
loft --native load_keys.loft http://127.0.0.1:8223/repro.store 100
#   0 ms per request ->  41 ms wall     20 requests
#  25 ms per request -> 592 ms wall     ⇒ wall ≈ base + requests × latency

# 2 — a POINTER-BEARING vector element is relocated field-at-a-time.
loft --native shapes.loft  rec  rec.store  200 250     # vector<Pt>      — scalars only
loft --native shapes2.loft txt  txt.store  200 250     # vector<Named>   — carries a text
loft --native shapes2.loft nest nest.store 200 250     # vector<Ring>    — nested vector
LOFT_LOADER_STATS=1 loft --native read_shapes.loft  rec  rec.store  100
LOFT_LOADER_STATS=1 loft --native read_shapes2.loft txt  txt.store  100
LOFT_LOADER_STATS=1 loft --native read_shapes2.loft nest nest.store 100
#  same 25 000 elements, 4-byte internal reads:  scalars 811 · text 75 836 · nested 75 827
```
