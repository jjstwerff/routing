<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# loft#787 — the keyed paged load, with the leverage

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-06 · **Owns:** the loft#787 workload reproducer — a keyed paged load with real leverage

The workload the ladder in loft#787 is missing: **162 cell keys of one z14 Amsterdam viewport** against a
**812 MB** base block, and the **404 pages** this project's index names for them. Roughly an order of
magnitude more read pressure than an Enschede z16 view (71 range reads), which is why a per-read cost is
visible here and inside the noise there.

Everything needed is public — no data from this machine:

```
store  https://jjstwerff.github.io/routing-data-nl-midwest/nl-midwest.base.store
bytes  812562696          sha256 587dc223fb0adb8f…      (answers a real 206 Range)
keys   keys.txt   — 162 tkeys, PTile, the app's own covering set for that viewport
pages  pages.txt  — 404 page numbers, what the page index names for those cells
```

## What it measures

`browser/cdp_lazy_cost.mjs` prefetches `pages.txt` into the host buffer FIRST, so the clock measures the
loader's own work with **no network in it**, then times `store_load_keys` over `keys.txt`:

```bash
node browser/cdp_lazy_cost.mjs <profile> <page-url> <store-url> base keys.txt pages.txt "1,4"
```

`interleave.mjs` is the A/B harness: two site roots, one per kernel, **alternating within one browser
session** and swapping which arm leads each round. That interleaving is the part that matters — the first
version of this measurement ran each arm in its own session, always in the same order, and reported 1.5×
where the interleaved answer is 1.14×.

## The numbers this produced here

CPU 4×, quiet box, medians of 4 interleaved, kernels differing only in the loft that built them:

| | wall | range reads |
|---|---|---|
| `7278b85f` (pre-arc) | 785 ms | 411 |
| `74d02068` (`c0e16c22`) | 896 ms | 369 |
| pure compute, same pair | 3 387 / 3 318 ms | — |

Slower with **fewer** reads and fewer bytes, and pure compute unchanged at 0.98× — which is what points
at per-read cost on the wasm sequential branch rather than at bytes, call count or codegen.
