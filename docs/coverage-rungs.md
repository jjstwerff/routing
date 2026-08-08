<!--
Copyright (c) 2026 Jurjen Stellingwerff
SPDX-License-Identifier: LGPL-3.0-or-later
-->

# The coverage ladder — what each rung cost, and what it proved

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-04 · **Owns:** the coverage ladder and what each country rung cost and proved

The rungs of `PLAN-SCALE` §6b, one per step out from a single city, with what each one **measured**
rather than what it planned. Read §6b for the ladder itself, then the rung you are standing on.
**A rung is entered by its gate, not by its data being published.**

⚠ **Section numbers are global to `PLAN-SCALE.md`** — they were not renumbered when this file was split out, so a citation of `PLAN-SCALE` §6e still resolves. Its *Where each section lives* table says which file holds which §.

---

## 6b. The coverage ladder — how it actually gets to WE

> **C3 and above are now a plan: [`plans/51-coverage-past-nl/`](plans/51-coverage-past-nl/README.md)
> ([routing#51](https://github.com/jjstwerff/routing/issues/51)).** This § stays as the reference — it
> records what each rung *proved*, and the entry gates the plan is measured against. ⚠ Every size below
> C2 predates loft#730's compaction (blocks halved 2026-08-03) and is stale until phase A re-costs it.


The steps above are *capabilities*; this is the *rollout*, and it is deliberately a ladder of small,
boring, revertible rungs. Each rung is a **real deployment** that a user can route on, each is entered only
when the named gates are green, and each can be the last one for a while without anything being
half-finished. **Coverage grows ~4–10× per rung, so a wall shows up while it is still cheap to hit.**

| rung | coverage | ≈ blocks / bytes (roads + layout) | needs | what it proves for the first time | entry gate |
|---|---|---|---|---|---|
| **C0** | today: 283 km², one block, whole-file | 1 / 24 MB | — | the app routes and renders at all | shipped |
| **C1a** | ✅ **DONE 2026-07-30, native AND browser** — no full-collection scans | 1 / 24 MB | S2 | keyed reads replacing scans — **at a size where a mistake is visible and cheap**; and the server reading a corridor at 7.3% of a block's bytes | `match_parity.sh` byte-identical; corridor tiles-touched a function of the sketch, not of the store |
| **C1b** | ✅ **DONE 2026-07-30** — the app can read its roads block by BYTE RANGE (`readMode: 'paged'`), route-identical; shipped OFF for this block, see below | 1 / 24 MB | ✅ [loft#678](https://github.com/loft-lang/loft/issues/678) | the working-set read path where the app actually runs | ✅ route + pixel hash unchanged; the gate asserts range reads happen and reports the fraction |
| **C2** | ✅ **DONE 2026-08-01 — the Netherlands ROUTES AND SEARCHES on Pages.** Roads (233 + 264 MB) and names (36 MB) same-origin and paged; base map (999 + 1058 MB) regenerated and on the release, awaiting D2. See §6c for the state and §6e for what it taught about WE | 2 halves / 0.53 + 2.06 GB | S6, S7, S9 | multi-block, hosting, a generator that streams | ✅ N0 green per half; S8 seam route identical; `nl_live_gate` routes + searches in Amsterdam |
| **C3** | ✅ **ENTERED 2026-08-03 — Benelux routes across its borders** (NL, BE, LU; the "+ one big neighbour" half is not done). **Sizes below were the pre-halving ESTIMATE and are superseded by §6j, which measured Benelux at 0.45 + 4.0 GB** — the roads half came in far cheaper | ~6 + ~12 / ~~1.5 + 9 GB~~ → **6 / 0.45 + 4.0 GB** measured | S4, S5, S8 | working-set eviction and the re-scoped render bridge under real panning; a cross-BORDER route between two countries | ✅ `seam_route_gate` — 4 crossings byte-identical against a merged reference (§6j) |
| **C4** | **WE roads, base map per region** (D1) | ~10–16 roads blocks / 7–15 GB; layout on demand | S10 | the product: a cold visitor routes anywhere in WE | C3 stable; 26-sketch corpus 0-worse; warm match inside its `CPU_THROTTLE=4` budget |
| **C5** | **WE base map** as coverage, not opt-in | +25–45 blocks / 44–88 GB — ⚠ §6e's disk-derived chunking says **34–68**, from a different direction | S0's real numbers, D2 cost check | that the map layer is affordable at all | C4 stable and S0 says the bytes are what §1 guessed |

⚠ **"a generator that streams" (C2's wants column) was answered in §6e, and it does not mean what it
sounds like.** The client already streams and already scales — a viewport costs the same
whatever the store's size (⚠ the 75–190 kB once quoted here is retracted; it is 8.1 MB — §6f below). What does not stream is the GENERATOR, which accumulates a whole store in memory (~350 bytes/feature;
130–270 GB for WE). The fix is not a bigger machine or a smaller store but **never building one that big**:
one region at a time, fed by a single `osmium extract --config` pass, which is the block structure C4/C5
already specify.

✅ **C1b is unblocked (2026-07-30).** It was blocked for nine hours; the plan was written to keep moving
without it and did not have to. C1a's work — ending the full-collection scans — is still the first thing to
build, because it needs nothing from anyone and every later rung stands on it. **C1b is now what the plan
said it would be: a URL policy change, same stores, same keys, no format change.**

**The refresh loop runs from C1a, not from C4.** Whatever the rung, the dataset it serves is produced by
§7's procedure — so the automation is exercised while it costs one small block, and by the time it manages
40 blocks it is the same script that has been running for months. *This is the one sequencing decision in
this plan that actually determines whether WE coverage is ever up to date* (§8).

Each rung's dataset is published under its own `v<date>/`, and **the rung below stays live** until the new
one has served real traffic. Rolling back a rung is flipping the index (rule 2), not regenerating anything.

⚠ **C5 is a genuine decision point, not a formality.** If S0's measurement puts the base map near the top
of its band, the honest options are: keep it per-region on demand forever (C4 is then the end state, and it
is a good one), reduce its detail (drop buildings outside urban cells, coarser cells at low zoom), or
source the map externally and keep loft on the route. Do not pre-commit storage to C5 before S0 reports.

---

### 6c. The NL rung, step by step (2026-07-31) — and what it costs to keep going

The ladder above is still the shape. This is the executable list for **C2**, written after re-measuring
what is actually on disk and on the wire, because three of C2's assumptions have moved.

**What is already true, measured today:**

> ## ✅ N0–N3 AND N6 ARE DONE (2026-08-01). The rung below is kept for its reasoning; this is the state.
>
> | | |
> |---|---|
> | NL roads | **live on Pages, same-origin, paged** — `nl-west` 233.4 MB + `nl-east` 263.9 MB, regenerated from a fresh md5-verified extract, carrying `RF_NET_*` network bits (`TRoad.flags` u8→u16) |
> | NL names | **new** — `nl.names.store`, 36.1 MB: 296 474 street names + 12 700 places, searched offline (PLAN-RESTORE R4) |
> | NL base | regenerated and published, **999.3 + 1058.3 MB** — smaller than the 1.44 GB halves it replaces *while carrying more categories* (loft#710's allocation artifact, favourably); stays on the release |
> | the site | **560.5 MB of a ~950 MB budget (59%)**, measured every build by `tools/site_size_gate.sh` |
> | release | `data-v2026-08-01`, 2.6 GB, every asset verified 206-and-correct-size before the index was uploaded |
> | refresh | `tools/refresh-region.sh` is the whole sequence; `data-refresh.yml` drives it, `workflow_dispatch` only |
>
> **N3's gate is `tools/nl_live_gate.sh`** — it opens the app in Amsterdam, where no other browser gate
> goes, and proves the claim end to end: resolves to `nl-west`, base `NONE`, routes 29 points, reads
> **17.7 MB of the 222 MB block (8.0%)** by Range, and finds "lonneker".

**What was true when this rung was written (2026-07-31), kept because the reasoning still holds:**

| | |
|---|---|
| release hosting | **Range yes, CORS no** — re-measured: `206` with a correct `Content-Range`, and no `access-control-allow-origin`. The note in `build_index.sh` is right, which is why the site index excludes them |
| Pages hosting | Range yes, ~1 GB per site. **NL roads fit. Roads + base do not.** |
| the blocks vs the pipeline | the base blocks were built `2026-07-30 17:01`; the classification work landed `2026-07-31 18:23`, so **they predate relations, sites, aeroway, heath/scrub and cemetery labels** |

**The one structural unknown**, and it is the whole difference between the two halves of this rung: the
roads store has a paged read path and the **base store does not**. `store-app.mjs` fetches `LAYOUT` as one
URL and `expose`s it into wasm memory. At 20 MB that is fine; at 1.44 GB it is not a tuning problem, it is
wasm32. **Routing over NL is a hosting-and-regeneration job. A base MAP over NL is a design job.**

⚠ **That framing was resolved by measurement on 2026-08-01, and the answer is not the one the two
candidates below assume — see §6e.** Paging the base map is *cheap*; hosting it is what binds. The
distinction matters because it moves the WE problem from the read path to the bucket.

---

#### The steps

Same rules as everywhere else here: one commit, one observable, gates green at each, and a rung stays
revertible by flipping the index rather than regenerating anything.

**N0 · The conservation gate — FIRST, before any country build.**
For a region, count OSM features per category out of the extract and compare against what the block holds:
ways per class, areas per cover, buildings, barriers, labels, lines. Not equality — filters legitimately
drop things — but a **floor per category and a hard fail on zero**.
*Why first:* every defect found by eye this week was **a whole category silently at or near zero** —
`service` roads absent from the draw order, multipolygon relations dropped by the parser, `amenity` never
collected, heath drawn as lawn. All of them reached the live map, and all of them are mechanically
detectable. At Enschede scale a human caught them because a human knows Enschede. **Nobody knows the
Netherlands well enough to catch them by looking**, which is the real reason this step is not optional.
*Observable:* deleting `w/building` from the recipe turns it red; a clean block is green.
*Cost:* one osmium pass per layer, seconds.

**N1 · Re-run it against Enschede.** No coverage change, no new data — the gate is proven on the one block
we can still check by eye and against a known-good result.
*Observable:* green on the shipped block; the counts are printed so the floors are visible, not implicit.

**N2 · Regenerate NL ROADS on today's pipeline.** Both halves, roads only. Still off the site index.
*Observable:* N0 green per half; `cross_block_gate` and `tile_border_gate` still route seam-identically;
`match_parity` byte-identical on the Enschede corpus (the kernel is shared, so this catches a regression in
the matcher, not in the data).
*Rollback:* nothing shipped yet.

**N3 · Put NL roads on Pages and make routing live.** 528 MB is under the ~1 GB cap and it is the **same
origin**, so the CORS wall does not apply — the site index can name them with relative URLs and
`read_mode = "paged"`. Enschede keeps supplying the base map; outside it you get roads and a route on a
plain background, which is a real product for a cyclist.
*Observable:* a cold visitor routes in Amsterdam; the deployed site stays under the cap (**measure it in
the deploy job, do not assume**); the paged gate reports range reads, not whole-file fetches.
*Rollback:* flip the index back to Enschede-only.
⚠ This is the step that makes the tool useful to someone outside Enschede. Everything before it is
preparation and everything after it is the map getting prettier.

**N4 · Decide the base-map read path — a MEASUREMENT, not a build.** ⚠ **ANSWERED 2026-08-01, and the
question was slightly wrong — see §6e.** Both candidates below assume the read path is what stops the base
map shipping. Measured, it is not: a viewport costs the same **whatever the store's total size**, which is
the property that matters. ⚠ **The number written here was 75–190 kB and is retracted — §6f measured 8.1 MB**
(21.8 MB in a dense metro); it came from a store-wide average tile times an unpadded cell count. Paging is
still about as cheap as paging the roads already is. What actually binds is that Pages caps the SITE at
~1 GB **and its BANDWIDTH at 100 GB/month — ~1 000 sessions (`docs/hosting-cost-model.md`)** — and the
bytes must live somewhere, which no read path and no amount of splitting changes. Kept below as written,
because the two candidates are still the right
two once hosting is settled:
  * **page the base like the roads** — `store_load_keys` over `PTile[tkey]`, which needs `expose` to work
    on a partially-filled store. That is the open question, and it is a loft question: if it cannot, the
    deliverable is an issue on `loft-lang/loft` with the probe as its reproducer, not a decoder here.
  * **cut the base into small per-city blocks** and load only the covering one — C2's original D11 shape,
    no new loft capability, more blocks to manage and a seam every time you pan across a city edge.
*Observable:* a browser probe that renders one viewport of base map out of a country-sized store, with the
bytes fetched reported. Until that number exists, N5 is not plannable.

**N5 · NL base map, built to whatever N4 answered.** ✅ **The REGENERATION half is done (2026-08-01)**:
185 564 tiles / 17 290 495 features, split at 5.40°E into 999.3 + 1058.3 MB, carrying every category the
old blocks lacked (heath 8620, scrub 58 791, reserve 1315, site 1553, border 309, powerline 3058, pylon
9148, cemetery labels 968). Published to `data-v2026-08-01`. **The HOSTING half is open and is D2** — 2 GB
does not fit beside a site already at 560 MB of 950. Regenerate with today's classification (relations,
sites, aeroway, heath/scrub, cemeteries — none of which the current 1.44 GB blocks have). Host per N4: if
it fits Pages, same origin and done; if not, the CORS bucket, for which `publish-bucket.sh` and
`cors_host_gate.sh` already exist and pass.
*Observable:* the reported map at a dozen sampled coordinates matches OSM by category — the same
conservation check, sampled rather than eyeballed.

**N6 · Turn the refresh loop on, for NL.** ✅ **DONE 2026-08-01, with the cron deliberately still off.**
All three defects below are fixed: the workflow drives `tools/refresh-region.sh` + `tools/publish-release.sh`
rather than its own inline commands, so it publishes from `blocks/`, tags `data-v<date>`, rebuilds the
index and gets per-asset 206 verification. It opens a **PR** for the regenerated index rather than pushing,
since `main` is protected. The cron stays off for three MEASURED reasons — the base map needs ~11.7 GB of
intermediates and does not fit a runner (so the job runs `--no-base`); publishing replaces data a deploy
verifies against, so an unscheduled republish reddens Pages until the index is committed; and loft is built
from `main`, where the fixes this repo needs are routinely fixed-pending-merge. `data-refresh.yml` is deliberately disabled and its publish step
is broken in three ways (uploads `dist/blocks/*` while the script writes `blocks/`; tags `data-202608`
where everything else uses `data-v2026-07-30`; never rebuilds the index nor runs `publish-release.sh`'s
verification). Fix those, run **N0 before publishing**, and re-enable the monthly cron.
*Why here and not later:* §8 already says it — the loop must run while it costs one country, not when it
manages forty blocks. A month-old NL map that is *known* to be a month old beats a fresh one nobody trusts.

---

#### And by extension, Western Europe

The rungs are unchanged (C3 → C4 → C5); what N0–N6 buy is that each becomes mechanical rather than a leap.

| rung | what it adds | the thing it proves for the first time | the wall to watch |
|---|---|---|---|
| **C3 · Benelux + one neighbour** | 2–3 more countries | working-set **eviction** under a 500 km pan, and a cross-BORDER route | peak memory; a border is a seam between datasets, not just blocks |
| **C4 · WE roads** | ~10–16 road blocks, 7–15 GB | a cold visitor routes anywhere in WE | **hosting cost and the index size** — 7–15 GB is past Pages, so C4 is where the bucket decision is forced whether or not N4 forced it |
| **C5 · WE base map** | +25–45 blocks, 44–88 GB | that the map layer is affordable at all | it may simply not be — see below |

**C5 remains a genuine decision point and N4 is what informs it.** If the base map cannot be paged, the
honest end state is C4: routes everywhere, detailed map per region on demand. That is a good product and
this plan should not pretend otherwise. The alternatives named in §6b — coarser cells at low zoom, no
buildings outside urban cells, or sourcing the base map externally and keeping loft on the route — are all
cheaper than 88 GB, and the choice between them is a **measurement** (N4, then S0 on real WE numbers), not
a preference.

**What would make me stop and re-plan rather than continue:** N4 says the base cannot be paged AND
per-city blocks put more than ~100 blocks in one index (the index itself becomes a download); or N3's
deployed site lands within 20% of the Pages cap, because the next country will not fit and the bucket
decision arrives a rung early.

### 6h. DO THE NL PATTERNS REACH WESTERN EUROPE? Measured verdict: three of them do not (2026-08-02)

The scale factor is not a guess. Geofabrik's own extracts for the thirteen countries of Western Europe
(FR, DE, GB, IT, ES, NL, BE, AT, CH, DK, PT, IE, LU) total **20.5 GB of source PBF against the
Netherlands' 1.40 GB — 14.7×.** Projecting this session's *measured* NL blocks linearly in source bytes:

| | NL measured | WE projected |
|---|---|---|
| base map | 2043 MB | **30.0 GB** (40.5 GB with the 0.10° margin) |
| roads | 238 MB | **3.5 GB** |
| names | 36 MB | 0.5 GB |
| regions at ~700 MB of base | 4 | **~58** |

**What still holds** — and it is most of the design. Paged reads (a viewport costs the same against a
1 GB store as a 20 MB one, proven), the tier rules (exactness is a property of the data, not of scale),
the covering set, the marks, the index-as-contract, and chunked generation. None of these care how big
the continent is.

**Three that break, in the order they will bite:**

1. **⚠ THE ROADS STOP FITTING THE SITE — 3.5 GB against a 0.95 GB Pages site, 3.7× over.** Today's split
   is "roads same-origin beside the app, base map elsewhere" (HANDOFF §0 rule 2), and at WE the roads are
   themselves too big for the app's own site. The mechanism to fix it already exists and is gated
   (`cors_host_gate.sh`: paged + CORS, cross-origin), but the RULE changes — every store moves off-origin
   and the site keeps only the app.
2. **⚠ ONE PAGES REPO PER REGION DOES NOT SCALE TO ~58 REPOS.** Four was a judgement call; fifty-eight
   public repositories, each with its own workflow and deploy, is not an operational shape. This is where
   **D2 stops being optional**: one R2 bucket holds 40.5 GB for roughly **$0.61/month** at $0.015/GB with
   no egress fee, against 58 repos that are free and unmanageable. `publish-bucket.sh` already exists and
   `data/bucket-cors.json` is the policy; what is missing is the account, not the code.
   **Costed 2026-08-04 in `docs/hosting-cost-model.md`** — and the headline there is that the repo
   count is the lesser problem: Pages' 100 GB/month bandwidth caps the app at **~1 000 sessions a
   month**, which binds at Benelux rather than at WE. R2 is the recommendation, one measurement short.
3. ~~**⚠ THE 62-BLOCK CEILING BINDS.**~~ — **FIXED, and it is the only one of the three that is.** The
   owner mask became an owner LIST, so an index has no per-block ceiling. It was measured rather than
   argued: `block_overlap_gate.sh` now runs the checker at **70 blocks** — where the old code refused
   outright — and, on the same 70, still rejects a manufactured partial overlap, because "ALL PASS at 70"
   is a verdict a checker that had quietly stopped comparing would also reach. **Breakages 1 and 2 above
   still stand**, and they are the ones that decide whether WE ships.

**Two more that are not new but get worse:**

* **The working set never shrinks** — there is no LRU anywhere in the kernel (grep: zero matches). A
  session panning from Paris to Berlin accumulates every cell it crossed, in wasm memory. Tolerable
  across NL; not across a continent. §6b Track 3 owns it.
* **The margin costs more as regions get smaller** (§6g): +35% measured across NL's four ~1°-wide
  regions, and worse for the smaller regions dense areas force. Per-region, cost-capped margins are the
  answer, with the covering set as the fallback.

**And the one the user feels, unchanged by any of this:** per-viewport bytes in a dense metro. An
Amsterdam z14 viewport is 21.8 MB of geometry; London and Paris are denser still, and no region plan,
bucket or block cap touches it. Generalisation is the only lever.

*Verdict: the read path scales as designed; the PUBLISHING and BOOKKEEPING do not.* The three breakages
are each small, known fixes — a bucket instead of repos, a wider overlap mask, and off-origin roads — but
they are prerequisites, not follow-ups, and none of them is the thing that decides whether the map feels
good in London.

⚠ **F5 is the lesson from shipping this blank.** `nl_live_gate` proved routing and search on the live site
and never asked whether anything was DRAWN, so a blank map passed every gate. Every future coverage claim
needs a render assertion, not just a route one.

#### What is still unknown, and the honest risks

* **F2 is the real engineering risk.** `expose`'s cost is O(collection), and a growing working set means
  re-exposing a growing store. If that turns out to be per-frame-expensive, the fallback is JS reading
  pages directly (§9 item 3's stated fallback) — not a decoder of our own (§0's rule).
* **Pages acceptable use.** GitHub documents Pages as not intended as a CDN, with soft limits of ~1 GB per
  site and 100 GB/month bandwidth. Paged reads make a visitor cost ~100 kB per viewport, so the bandwidth
  is unremarkable — but three data repos holding 2 GB of map tiles is a judgement call, and it should be a
  deliberate one. **D2 (R2/B2) remains the answer that scales**: at WE's 44–88 GB this stops being a
  judgement call and becomes a bucket, for roughly $0.66–1.32/month of storage with no egress fee on R2.
* **Three repos is an NL answer, not a WE one.** 44–88 GB would be 45–90 Pages repos. Do not build
  tooling that assumes this shape; F4 should be "publish to a base URL", with the URL a config value.

#### Why not the alternatives

* **Shrink it** — buildings (53.7%) + areas (38.5%) are 92% of the bytes, and buildings are already lean
  at 7.9 coords each. Dropping buildings ENTIRELY and halving areas still lands at ~700 MB against ~390 MB
  of free budget. There is no 5x, and it costs the detail that makes the map worth having.
* **Split it further onto the SAME site** — the cap is on total site bytes. 2 GB in eight parts is 2 GB.
* **An overview tier only** (no buildings, no pois, big areas simplified, place labels) measures at
  **75 MB west / 94 MB east** and WOULD fit the current budget. Worth keeping in the back pocket as a
  never-blank fallback, but it is not "full support" — it is a different, thinner map.
  ⚠ **§6i explains that number and shows it is a plateau, not a floor.** 75/94 MB is what SELECTION alone
  buys: keeping only what a low zoom draws keeps 4% of the features and **45% of the coordinates**, because
  the features it keeps are the huge ones. Adding 1-pixel decimation takes the same window to 1.2% of
  coordinates at z≤10. The overview is not a thinner map you settle for — it is the top of a ladder.

### 6j. The BENELUX rung (C3) — measured, trimmed, and ENTERED (2026-08-03)

The sibling of §6c one country out. `plans/51-coverage-past-nl/` owns the *intent* and the phase
ladder; this is what the rung **proved**, which is reference. It supersedes §6b's C3 row above.

**Belgium and Luxembourg were BUILT, not modelled.** Raw block bytes (roads compact to ~0.5× at bind;
base does not):

| | roads | base | base tiles / features |
|---|---|---|---|
| Netherlands | 272 MB | 2691 MB *(4 regions)* | 186 215 / 17.3 M |
| **Belgium** | **159.5 MB** | **1202.5 MB** | 148 858 / 10.7 M |
| **Luxembourg** | **16.9 MB** | **70.6 MB** | 14 246 / 0.56 M |
| **Benelux** | **~449 MB** | **~3965 MB** | |

1. ⚠ **Base size does NOT track road density, so the extrapolation would have been wrong.** Belgium is
   53% of the Netherlands by road ways but **44%** by base bytes; Luxembourg is 6% by roads and **2.6%**
   by base. The base map is buildings and landcover, and those do not scale with the road network. This
   is why the rung insisted on a real block rather than a model.
2. **Belgium cannot ship as ONE base block** — 1202.5 MB against the ~1 GB per-site cap, so it needs
   cutting exactly as the Netherlands did. Luxembourg at 70.6 MB is comfortably one, or rides with a
   Belgian region. **Benelux is ~7 base hosts** (NL 4 + BE 2 + LU 1) against the 4 live today.
3. **§6b was pessimistic on roads and close on base.** It put C3 — Benelux *plus a big neighbour* — at
   ~1.5 GB roads + ~9 GB base. Benelux alone is 0.45 + 4.0 GB: the roads half came in far cheaper than
   the pre-halving model assumed (loft#729/#730 took the four NL roads blocks 478.6 → 255.5 MB while
   carrying *more* data).

#### Raw country extracts OVERLAP — 377 shared cells, and PARTIAL

`block_overlap_gate`'s question stopped being theoretical the moment a second country existed. A raw
Geofabrik Belgium extract against the four live Netherlands regions:

```
blocks 0 and 4 PARTIALLY overlap: 143 shared cells   (nl-west    vs belgium)
blocks 1 and 4 PARTIALLY overlap: 108 shared cells   (nl-midwest vs belgium)
blocks 2 and 4 PARTIALLY overlap: 111 shared cells   (nl-mideast vs belgium)
blocks 3 and 4 PARTIALLY overlap:  15 shared cells   (nl-east    vs belgium)
```

**Neither block is a subset.** Belgium's extent reaches lat 53.74 / lon 1.89, well inside the
Netherlands, because `osmium extract` keeps whole ways and Geofabrik's country files deliberately carry
cross-border data. A corridor over the border would read those roads twice and match a **different**
route, not a slower one.

So a neighbour is **not** "download it and add it to the index" — but it is also not a re-tiling. **D12
(§3) owns the rule**: roads are a disjoint PARTITION because a corridor read is unbounded, the base map
an overlapping COVER because a viewport is bounded. What follows for a neighbour is a **TRIM** of its
*roads* to cells the live index does not own; its base map may keep overlapping, as the four NL regions
do today. The 377 cells above are the trim list, and the gate that found them already computes it.

#### `tools/tiling_probe.py` — measuring a tiling without building it

"Do these overlap?" and "how many regions?" cost a full `gen-tiles` run: **25 min and 1.8 GB RSS** for
Belgium, and the input grows several times again for France or Germany. Neither question needs a store —
a feature is keyed at its FIRST VERTEX, so its cell is one `floordiv` on one coordinate, and a block's
bytes track its coordinate count. The probe streams the geojsonseq the pipeline already produces and
emits the cell set plus the counts. **Belgium in 8.4 s against 25 min**, validated rather than asserted:

| check | probe | real block | error |
|---|---|---|---|
| cells, 3 real blocks | — | — | within **0.25%** |
| bytes per coordinate | ~15 | ~15 | constant across all three |
| NL∩BE shared cells | 397 | 377 | +5.3%, and on the safe side |

⚠ **It answers about the TILING, not about the block.** It cannot say a route is correct or a category
survived — `conservation_gate` and `block_overlap_gate` still own those, on real blocks. It is the cheap
screen you run *before* committing an hour of CPU.

#### Building in bands — `tools/build-blocks-banded.sh`

`tools/build-base-chunked.sh` already did this for the base map; the banded build does it for roads,
cutting longitude bands whose edges come from the probe's even-**cost** histogram — even *width* is
rarely even cost. Belgium in 3 bands, against the whole-country block:

| | b0 `[2.52, 4.1)` | b1 `[4.1, 5.2)` | b2 `[5.2, 6.43]` | sum | whole country |
|---|---|---|---|---|---|
| ways | 404 583 | 693 186 | 382 982 | **1 480 751** | 1 480 755 |
| cells | 2 748 | 4 219 | 3 406 | **10 373** | 10 374 |
| bytes | 82 MB | 133 MB | 84 MB | 299 MB | 159.5 MB *(compacted)* |

✅ **Disjoint** — `block_overlap.loft`: 0 nested pairs, no partial overlap over all 10 373 cells.

✅ **Complete everywhere inside the requested area** — and this took a second tool to see.
`tools/cell_diff.loft` compares a reference block against a set of parts on **both** axes: which cells no
part holds, *and* which cells every part holds but **under-fills**. A cell-set diff alone could not have
found this, because the missing ways were in a cell that was present. Exactly two cells of 10 374 differ,
and **neither is at a band seam** (those are lon 4.1 and 5.2):

| | cell | lon | lat | vs Belgium's bbox `2.5231,49.4967,6.4253,51.5051` |
|---|---|---|---|---|
| **MISSING** | 125562201 | 5.56–5.58 | 49.46–49.48 | wholly **south** of 49.4967 — outside it. Holds **0 ways** (a barrier-only tile) |
| **SHORT** −4 ways | 127398467 | 4.76–4.78 | 51.50–51.52 | **straddles** the north bound 51.5051 |

**The mechanism, and it is not the band cut.** `osmium extract` keeps a way when *any* node falls in the
bbox, and a block keys it at its **FIRST VERTEX** — which may be outside. A way skimming the northern
border can be anchored beyond it, and whether it survives depends on which longitude window you extract;
the 0.15° margin only reaches ways shorter than the margin. Both differing cells are **artifacts of the
country bbox, not of the banding** — the whole-country block has them for the same accidental reason.

**Verdict: the banded build is exact where it is asked to be.** All 10 372 cells inside the bbox match
the whole-country block in cell *and* way count. What banding changes is which border artifacts come
along, and those are anchored outside the area by definition. `cell_diff` is now the **C2b** half of
`block_overlap_gate.sh`, so a cut set is checked against its source (named by the manifest's `cut_from`)
on every run — the live four-region NL dataset passes at 12 483 cells. When no reference exists — which
is the whole point of banding — the sum against `<block>.srccount` plus a `block_overlap` pass is the
check.

⚠ **Two traps, both also in HANDOFF §2.** A region's outer edges are NOT seams — trimming its own bounds
ate the cell containing the eastern bound. And an earlier run's numbers were **contaminated** because it
did not delete its blocks first: `store_persist_bind` over an existing file keeps the old image while
returning `true`, so band 1 reported 4 ways it had not built, from a byte-identical extract.

#### The generator's memory — bind FIRST, and it is RECLAIMABLE (this is what §6e turns on)

> ⚠ **This rung first recorded the OPPOSITE — that binding first was 4.5× worse and key order changed
> nothing.** Both halves were wrong. The measurement was correct for the binary it ran on (loft 2026.8.0
> md5 `0849e437…`, where [loft#746](https://github.com/loft-lang/loft/issues/746) broke the bind-first
> insert path), and it was a **throwaway probe**, so nobody could re-run it when upstream disagreed. It
> is now `tools/bind_order_gate.sh`, and the numbers below come from it.

Re-measured on loft 2026.8.0 md5 `276cf8f9…` (2026-08-03 19:06), binning **400 000 roads into 40 000
tiles at 10 steps per road** — `gen-tiles.loft`'s shape, inner-vector appends included, because that is
the detail the old finding turned on:

| | bind LAST | bind FIRST | |
|---|---|---|---|
| **scattered keys** | 292 MB | **85 MB** | bind-first **3.4× lower** |
| **ordered keys** (fed in tkey order) | 622 MB | **117 MB** | bind-first **5.3× lower** |

At 1.6 M roads / 160 k tiles the direction holds and the ratio narrows — 765 → 273 MB scattered (2.8×),
1633 → 458 MB ordered (3.6×). **Binding first is the cheaper order, not the more expensive one.**

**And a bound store's memory is RECLAIMABLE, which is the half that decides §6e.** It is file-backed, so
its pages can be written back and evicted; an unbound `hash` is anonymous heap and cannot. Under a cgroup
cap with swap disabled:

| | 400 k / 40 k | 1.6 M / 160 k |
|---|---|---|
| bind FIRST, capped at half its uncapped RSS | **completes** (44 MB peak, 6.1 s vs 3.2 s) | **completes** (88 MB peak, 27.6 s vs 12.7 s) |
| bind LAST, same cap | **OOM-killed** | **OOM-killed** (kernel: `Failed with result 'oom-kill'`) |

That is the difference between a dataset that sets a *throughput* cost and one that sets a *memory
requirement*. Three limits, so this does not become the next stale premise:

1. **The floor is not zero and it grows.** 400 k completes at 48 MB and dies at 32; 1.6 M was only tested
   down to 96 MB. Capping costs ~2× wall at both scales — gentler than the 271 s cliff upstream saw at
   32 MB, but not free.
2. **WE remains an extrapolation.** This measured to 1.6 M features; WE is two orders of magnitude more.
   What is now *settled* is that §6e's 130–270 GB is a **bind-LAST** number, not that WE fits.
3. ⚠ **`MemoryMax` alone proves nothing on a box with swap.** The first run had both orders "completing"
   under 96 MB, because this machine has 8 GB of swap and bind-last simply paged out. `MemorySwapMax=0`
   is what separates eviction from swapping — the gate sets it, and the two orders come apart the moment
   it does.

**Key order costs ~1.4× the RSS, and the ~~2.3× file~~ was RETRACTED the same day** — a bound store's
file is its CAPACITY, on a ladder whose every rung is 7/3 of the last, and ordered insertion had merely
tipped one rung ([loft#752](https://github.com/loft-lang/loft/issues/752)). After `store_reclaim` the
real difference is **132 against 83 MB**, interior fragmentation rather than capacity. ⚠ **So "stream the
input in cell order" is still the right advice**, and this rung came within one commit of recording the
opposite: order it for locality if you were going to, and call `store_reclaim` at the end. The full
write-up is `docs/loft-feedback.md` (2026-08-03), and the rule it leaves is that **two
`store_persist_bind` outputs may never be compared by `stat`** — under 133% any difference may be one
rung, and any equality may be hiding a doubling.

#### The trim: the obvious rule would have put a HOLE in the border

The rule as first specified — *"trim the neighbour's roads to cells the live index does not already
own"* — assumes the 377 shared cells are Dutch cells Belgium reached into. `cell_diff` says they run
**both directions at once**:

| | cells | Belgium holds | the NL regions hold |
|---|---|---|---|
| Belgium holds more | 200 | **22 635 ways** | 5 428 |
| the Netherlands holds more | 170 | 5 441 | **23 294 ways** |
| equal | 7 | — | — |

One cell at 4.80–4.82°E / 51.46°N carries **183 ways in Belgium and 1 in the Netherlands**; another at
5.00–5.02°E / 51.48°N carries **1 in Belgium and 87** in the Netherlands. Both extracts keep whole ways,
so each country's file holds clipped fragments of the other. **Dropping all 377 from Belgium therefore
deletes 22 635 Belgian ways along the northern border** and leaves a 5 428-way fragment in their place —
a hole exactly where a cross-border route goes. It would have passed `block_overlap_gate` and failed the
seam route.

**The rule used instead:** every shared cell goes to whichever block actually **holds more** of it; ties
go to the higher-priority block, and **LIVE regions outrank staged ones** so nothing published moves
without cause. `tools/trim-borders.sh`, verified by `block_overlap.loft` on the RESULT rather than
argued from the drop lists: **6 blocks, 23 299 cells, 0 overlapping.**

| | before | after | given up |
|---|---|---|---|
| the four NL regions | 2 785 476 ways | 2 780 048 | 5 428 (200 cells) |
| Belgium | 1 480 755 | 1 473 174 | 7 581 (247 cells) |
| Luxembourg | 139 566 | 138 438 | 1 128 (56 cells) |

**14 137 ways of 4 405 797 — 0.32%** — against ~28 500 lost one-sidedly by the specified trim, and lost
from the side that held *less* of each cell rather than from Belgium regardless.

⚠ **It is not lossless and cannot be.** `TRoad` carries no way id, so two blocks' versions of a cell
cannot be merged and deduplicated — there is no key to dedupe on. Majority assignment loses whatever the
minority side held that the winner did not. **If `TRoad` ever gains a way id this becomes a merge.**

Two things it found that nothing had asked:

* **Luxembourg is disjoint from the live index but NOT from Belgium** — 126 shared cells. The staged
  section of `block_overlap_gate` compares each staged block against the LIVE index only, so "Luxembourg
  could ship today" was true as scoped and wrong as a conclusion the moment Belgium ships too. **The trim
  is pairwise over the whole set** for that reason.
* **The script is the deliverable, not the blocks.** The first run was a sequence of shell commands,
  which HANDOFF §2 says is not a pipeline — the same failure that had `data-refresh.yml` cutting two
  halves against a four-region manifest. Re-running `trim-borders.sh` from scratch reproduces every one
  of the twelve per-block cell and way counts. (Not byte-identical — see the `stat` warning above.)

**It shipped whole, and it had to.** The trimmed set is the live one in `v2026-08-03d`. **Leaving Belgium
staged would have left the cells the NL regions gave up owned by NOBODY** — a hole inside the
Netherlands, at the border, exactly where a cross-border route goes: either the whole set ships or none
of it does. Two consequences are in HANDOFF §2 rather than here — **conservation became a property of the
INDEX, not of one country's cut** (a cell that leaves the Netherlands has not vanished, it has MOVED, so
`OVER` is the trim's fingerprint while MISSING and SHORT stay hard failures), and **a gate pointed at a
staging directory goes green when the staging ends** (`seam_route_gate` read `blocks/trim` and SKIPped
the moment that set became the real one — passing, having tested nothing).

#### The seam route — the rung's entry condition

**A route from the Netherlands into Belgium is byte-identical to the same route matched against a single
block covering both.** `tools/seam_route_gate.sh`, four crossings at four longitudes across two Dutch
blocks, every one identical in way count, point count and route fingerprint:

| crossing | Dutch block | cells | route |
|---|---|---|---|
| Bergen op Zoom → Antwerpen | `nl-west` | 61 NL + 48 BE | 193 pts, identical |
| Breda → Turnhout | `nl-midwest` | 51 + 57 | 384 pts, identical |
| Baarle, through the enclaves | `nl-midwest` | 16 + 11 | 129 pts, identical |
| Reusel → Arendonk | `nl-midwest` | 11 + 29 | 283 pts, identical |

**Why the internal gate could not answer it.** `cross_block_gate` asks the same question one country in
and gets its reference free: it MANUFACTURES a seam by splitting a block it already has, so the unsplit
original is the answer. **At a real border there is no original** — the two blocks came from different
Geofabrik extracts and no file has ever held both. So `tools/merge_blocks.loft` builds the reference by
merging them, and refuses inputs that are not a partition; the gate therefore rests on the trim being
right and says so when it is not. `cross_block_probe.loft` gained a trace argument so one instrument
answers both seams — two probes would not have produced comparable results.

⚠ **The negative control fired on the gate's own first draft.** The rung asks for *a sketch that
STRADDLES the cut, not one that merely nears it*. The first corpus paired the Bergen op Zoom → Antwerpen
crossing (lon 4.29) with `nl-midwest`, whose band is **4.70–5.40** — so that route's Dutch side lives in
`nl-west`. The corridor drew **0 cells** from the block it was given and 48 from Belgium, and the probe
reported it **VACUOUS rather than passing**. That is the whole value of the check: paired with the wrong
block, a border test proves nothing and its output is indistinguishable from a pass. A crossing must run
against the block that actually holds its Dutch side, and the gate covers two pairs for that reason.

#### Two defects the rung found before producing a single size

* **The 62-block cap** — WE is 34–68 blocks, so it would have bound at exactly this rung. The owner list
  replaced the 62-bit mask; `block_overlap_gate.sh` proves **70 blocks** (2 415 nested pairs = 70 choose 2
  on identical copies) where the old code refused outright, and still rejects a manufactured overlap of 39
  shared cells, so it is not vacuous. It is also *faster*: the mask forced an O(blocks²) scan per cell —
  3 844 iterations at 62 blocks — where almost every cell has ONE owner, so the check is now linear in
  cells rather than cells × blocks². ⚠ The code fix shipped with no test, so for a day the ceiling was
  gone only by inspection.
* **The paged spot check was vacuous outside Enschede.** `page_locality_probe.loft` hardcoded its
  viewport, so `build-blocks.sh` printed `asked=42 loaded=0 roads=0` for Belgium and carried on — a pass,
  for a read path that fetched nothing. It now derives the viewport from the block's own extent:
  **42/42 keys, 8 491 roads** on the same block. It would have read as a pass for every country C3 adds.
