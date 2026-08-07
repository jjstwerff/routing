# HANDOFF ARCHIVE — the dated rungs, 2026-07-07 → 2026-08-02

**This is history, not state.** `HANDOFF.md` is the resume state; this file is what it used to say, kept
verbatim because each rung records what something COST to learn and those receipts outlive the status
they were attached to.

Read it when you want the account behind a rule — why a store's extent is not a geographic bound, why a
gate must not write the tree it checks, why the toolchain claim is anchored to an md5. Do not read it for
"where things are": every rung below was current on its date and several are now superseded.

⚠ **Where a rung disagrees with `HANDOFF.md` or a `PLAN-*.md`, the plan wins.** The rungs are ordered
newest-first, so the further down you read, the older the claim.

---

## 0-2026-08-07b. The loft #785/#787 arc, lifted from `HANDOFF.md` §2

Kept for the measurements and the retraction path; both issues are closed and the wasm pin is gone.

* ⚠ **AND THE SAME WORK COSTS A VIEWPORT 3-4x THE BYTES** —
  [loft#785](https://github.com/loft-lang/loft/issues/785), filed. On `nl-midwest.base` (812 MB), one z14
  viewport's 162 cells: **410 requests / 26.9 MB → 1 074 / 81.4 MB**, both backends, A/B'd against a
  binary that predates the change. It is SIZE- and SCATTER-dependent, which is why it hides: the small
  synthetic stores got 4-7x BETTER (21 requests → 3) on the same binaries. A large file plus a scattered
  key set inverts it — and that is exactly a map viewport. `tools/loft_repro/` reproduces it in 138 MB.
  ✅ **FIXED and committed** (`97210ff1`, *"a prefetched page must still be resident when the walk reads
  it"* — a page-cache eviction). Natively the whole arc is now a WIN: **410 requests / 26.87 MB → 368 /
  26.74 MB** on the 812 MB block, better than before it started.
  ✅ **AND THE BROWSER REGRESSION IS CLOSED** on loft `759a4172` (2026-08-06 18:46): the same keyed load
  is **694 ms at CPU 4x against the pre-arc baseline's 763**, with 42 fewer reads — faster than before the
  arc started. The path there is worth keeping: **1.5x (measured with the arms in SEPARATE browser
  sessions, always in the same order — withdrawn) → 1.14x (interleaved, real) → 1.03x**. The maintainer
  refuted all three of my guessed mechanisms and found it: a heap `Vec` allocated per read in `u32_at`,
  plus a page key hashed twice. ⚠ **The wasm may be rebuilt again** — the reason it was pinned is gone.
  ⚠ **THE ORIGINAL REPORT SAID ~1.5x AND THAT NUMBER WAS METHOD, NOT RUNTIME** —
  [loft#787](https://github.com/loft-lang/loft/issues/787), filed. Two `--html` kernels from IDENTICAL
  sources (`7c007439b990`), differing only in the loft that built them, quiet box, medians of 3:
  **177 → 254 ms at CPU 1x and 676 → 1 018 ms at CPU 4x**, for 10% fewer reads. The browser takes the
  sequential path by design (#784), so it pays the new relocate's CPU without collecting the batching's
  round-trip saving. **`browser/store-kernel.wasm` therefore STAYS on the older runtime** — on Pages the
  app is latency- and CPU-bound, and 1.5x decode on a phone outweighs 10% fewer requests.
  ⚠ The earlier note that the fix arrived UNCOMMITTED still stands as a rule:
  — 368 requests / 26.74 MB, better than the 410 / 26.87 MB baseline. `../loft`'s tree is dirty
  (`M src/paged_reader.rs`, a new `785-page-cache-amplification.loft`), so that number is in-flight work,
  not a property. **Do not rebuild `browser/store-kernel.wasm` against an uncommitted runtime**; wait for
  the fix to land on a commit. This is HANDOFF §2's sibling-tree rule paying for itself twice in one day.

## 0-2026-08-07. Lifted from `HANDOFF.md` — the Benelux build and the panning session

Both sections were current on their dates and are kept verbatim for the receipts inside them: the
five measurements that came out the opposite way, and the three gates that were sampling a moving
app. `HANDOFF.md` §0 carries the state they used to carry.

## 0b. How Benelux was built, and five upstream findings

**Landed as PR #55** (`build-test` 4m23s, `deploy` 24s), on top of `data-v2026-08-03d` — 23 assets,
784 MB, each verified by a ranged GET before the index pointed anywhere.

⚠ **Only 784 MB was uploaded, not 3.91 GB.** The four NL base maps and `nl-mid` (3.12 GB) are unchanged
and already served by their own Pages repos. `publish-release.sh` would have taken all of them — stage
the referenced set and point `BLOCKS_OUT` at it, as HANDOFF has warned since §3.

### The data, in the order it was built

1. **Derived blocks** so Belgium is not blank below z14 — `overview` (renamed from `nl-overview`,
   46.4 MB, spans the whole coverage), `be-mid` 149.3 MB, `lu-mid` 17.0 MB.
2. **The border trim** (@51 phase C) — `tools/trim-borders.sh`. 6 blocks, 23 299 cells, disjoint.
3. **Heights** for BE/LU, then **names**: `coverage.names.store`, 63.5 MB, 518 804 records.
4. **Published** as `v2026-08-03d`.

### Five things that were measured and came out the OPPOSITE way

Each cost a wrong claim that was already written down, about to be, or already filed upstream:

* **Binding a store FIRST is 3–5× CHEAPER, not 4.5× worse.** @51 said the reverse; it was measured
  against loft#746 on a binary that no longer exists. `tools/bind_order_gate.sh` is the re-runnable form.
  A bound store's pages are evictable — bind-first completes under a cgroup cap where bind-last is
  OOM-killed. **`PLAN-SCALE` §6e's 130–270 GB is a bind-LAST number.**
* **"Key order changes the file 2.3×" was RETRACTED.** A store's file is its CAPACITY, on a 7/3 ladder
  (loft#752): 250k, 300k and 400k roads all persist to *exactly* 91 419 400 bytes. Real effect after
  `store_reclaim` is ~1.5×. **"Stream in cell order" still stands** — @51 came one commit from recording
  the opposite.
* **z13 elevation is not worth adopting.** Belgium and Luxembourg baked both ways: mean |Δ| **1.15 m and
  1.41 m**, and the RANGE is identical (568 m). Luxembourg is the hilliest ground in the dataset, so the
  "sample by terrain, not by country" hypothesis is refuted too. `PLAN-RESTORE` §5 decision 3 is answered.
* **The 0.8% of unsampled steps was a PADDING bug, not resolution.** `bake-heights` pads 0.35° now
  (`TERRAIN_PAD`) and z12 fills 100%.
* **loft#757, which WE filed, was refuted — the refusal we called a bug was the diagnosis.** A field bind
  writes a container-rooted file *by design*; what we asked for would have made the load SUCCEED on
  mismatched bytes. The rule survives, the reason did not (§2), and `loft_bug_gate` guards a CONTRACT now
  instead of watching a defect.

### The upstream ledger

| | |
|---|---|
| **loft#739** | ✅ fixed; **both workarounds deleted**. `loft_bug_gate` FAILS if either returns |
| **loft#747** | our finding refuted by the maintainer, ours retracted; the capability is there |
| **loft#752** | filed by the maintainer — the capacity ladder should not be visible |
| **loft#757** | **filed by us, then REFUTED and closed** — the sidecar is honest; the rule survives (§2) |
| **loft#762** | **filed by us, fixed same day** — and our diagnosis was corrected on the way (§0c) |

### New tools, all gated

`bind_order_gate`+`probe` · `trim_cells` · `trim-borders.sh` · `merge_blocks` · `reseat_schema` ·
`height_diff` · `find_probe` · `loft_schema_probe` · `derived_scope_gate` (in `make test`) ·
`seam_route_gate` (@51 D).

---

## 0c. The session after it: panning, and three gates that were measuring a moving app

**Landed** (`view-ring-prefetch`, then #65–#69). Nothing here touches the data or the live site; it is
the app's read strategy plus the instruments that broke when the app grew background work.

> ⚠ **This section is why §0 is dated.** It once carried a warning that two branches were unmerged and
> that *"a session that resumes from `main` reads that first"* — and the warning then outlived the merge
> by three days, so `main` spent them telling every reader to land work that was already in. **A status
> section that is not corrected on the way past is worse than no status section**, because it is read
> with the authority of the rest of the file. Retire the warning in the SAME commit that removes its
> cause.

**The view no longer makes the screen wait for four screens it cannot show.** It read `viewportBox(0.6)`
— 2.2 × 2.2 screens, 4.84 screens of area — in ONE kernel call. Now it reads ~one screen, and a RING of
eight screen-sized cells is paged AFTERWARDS (3 × 3 = 9 screens), which the first paint pays nothing for.
Measured `CPU_THROTTLE=4`, n=3 a side, quiet box:

| | baseline | ring |
|---|---|---|
| **view call** | 83 ms *(82–85)* | **50 ms** *(49–51)* — **1.66×**, and the freeze halves with it |
| wasm working set | 532.9 MB | **531.0 MB** — nine screens PAGED is not nine screens RESIDENT |
| match / matchWarm | 2306 / 382 ms | unchanged; spreads too wide to claim either way |

Four things the ring needed, each found by measuring rather than by design — the ring is **chained, not
fanned out** (KernelQueue cannot preempt a running job, so eight queued cells would put the user's next
click behind eight screens of paging); the ring is **PROMOTED** when complete (the index is rebuilt over
the whole 3 × 3 from resident tiles, no fetch, or the smaller read would make the app hold LESS than the
old box and re-view more often); a **cell must never change the SOURCE** (a neighbour can be another
block, and pulling a foreign store into a session whose layout store is exposed TRAPS); and the **store
can move under the drawn map**, so the index's `storeBase` is compared and rebuilt only on a change.

`runKernel` now serialises internally, which is a fix older than the ring: `resolveRun` is ONE slot, so a
second call orphans the first promise. The queue guarded the APP's road; the ~20 `__perfHooks` probes
bypass it deliberately, and a ring cell landing between a probe's `reset` and its `match` returned an
empty route. Serialising at the root fixes all twenty instead of twenty call sites.

**A sidecar is fetched once now, not once per command** — 15 fetches → 2 + 13 cached, which is fewer than
main's 5. See §2 for what that count had been hiding.

### loft#762, and being wrong in public

We filed `for _ in <hash>` failing `--native` and narrowed it to *(bound store, discarded loop variable)*.
**The store was incidental and the narrowing was wrong.** `_` is ONE variable per function: `_ = delete(p)`
typed it `u8`, and `for _ in a` then assigned a `DbRef` to the same slot. The store appeared only because
our repro used `delete` to set one up. Fixed the same day — the loop binding now gets its own `let mut
var____1` inside the loop, and body reads of `_` resolve to it, so `_` stays readable. Verified here on
both backends. **Two of our three upstream findings this week were corrected by the maintainer** (#757,
#762); both times the report was useful and the *cause* we attached to it was not.

---


## 0. START HERE (2026-08-02, late) — THE APP OPENS ON THE NETHERLANDS, AND IT IS LIVE

**https://jjstwerff.github.io/routing/** — a bare visit now draws the whole country in **one 19.6 MB
request, 132 094 features, ~0.6 s**, and every zoom below 14 is answered by that one file. Nothing is in
flight: PRs #41–#44 are merged, `main` is `0a399e4`, and the deploy is green.

| zoom | before tonight | now |
|---|---|---|
| bare visit | Enschede z16 | **the country, 1 request** |
| z11 / z12 / z13 | 40 554 / 10 314 / 2 694 cell keys (~8 GB / 2 GB / 539 MB) | **the same file, 0.5 s** |
| z14+ | detailed regions, paged | unchanged, byte for byte |

**The design is `PLAN-SCALE` §6i** — the overview ladder, written against measurements, with the three
designs its probes killed recorded beside it. Read that before touching any of this.

### What shipped tonight

| | |
|---|---|
| **overview block** | the country generalised to what a low zoom shows: **17 290 495 features → 132 094, 159 Mcoords → 774 431, 19.6 MB**, built in 11 s by `tools/build_overview.loft`. Published on `data-v2026-08-02` |
| **zoom bands** | `zoom_min`/`zoom_max` per block in the index; JS selects on them. Below the handover the overview alone, above it the regions alone |
| **sketch densification** | a country-zoom drag returned NO route (the matcher echoes the trace). Retries densified **only on the echo**, so every already-working match stays byte-identical |
| **the debut ladder** | `areaMinZoom` stopped at 0.008° and sent everything larger to z0. Continued now — the z8 view draws **2 838 areas instead of 103 262** |
| **Enschede** | **no longer a coverage region** — a gate FIXTURE (`data/coverage-fixture.toml`) |
| **gates** | `tools/overview_gate.sh`, 14 checks, in `make test-map` |

### Four bugs reported from the live site, all fixed and verified there

1. **Zoom in from the country never switched to detail** — `ensureViewNow` skips the kernel when the new
   viewport is inside `loadedBox`, and the country box CONTAINS every later viewport. A box test cannot
   see a change of SOURCE, and crossing the handover is exactly that.
2. **Enschede drew nothing, inside NL** — the city block is chosen by its ROADS extent (6.74–7.01°E) while
   its BASE was clipped to 6.761–7.027. In the gap: **Hengelo 3 802 buildings, now 41 643**. Verified the
   country data loses nothing — same viewport, city block 189 tiles / 99 175 features, `nl-east` **207 /
   99 928**.
3. **The debut ladder shipped as a NO-OP** and everything passed. Areas draw from the store index through
   `_drawAreasFromStore`, which carried a **sixth inline copy** of the thresholds. See the warning below.
4. **A roads-less block as the boot FALLBACK crashed the app** — `resolveCoverage` fell back to
   `blocks[0]`, the overview, and `coverage.block.roads.url` threw, so `window.__map0` never existed.

### ⚠ Three traps this session paid for — read these before trusting a green run

* **A rule is not in force until the code that DRAWS asks it.** The ladder was extended, six unit tests
  passed, a browser gate passed, CI passed, the site redeployed — and the map was identical, because the
  tests exercised the parity path and the drawing path had its own copy. **Consolidating five copies while
  leaving a sixth is worse than leaving five**, because the survivor then looks authoritative.
* **Two instruments lied, in opposite directions.** `cdp_live_render.mjs` does NOT reload when only the
  URL fragment changes, so two different cities returned identical numbers; and a 6-second wait read a
  working transition as broken (a cold paged view takes ~18 s). Both times the probe was the defect.
* **A gate must not write the tree it checks.** `cross_block_browser_gate` called `build_index.sh` with no
  output argument — the default is the COMMITTED index. That is `8c47628` returning; it writes to `_site`
  now.

### Where to go next, in the order the evidence favours

1. **[loft#729](https://github.com/loft-lang/loft/issues/729) — `store_load_keys` fetches ~4× the bytes of
   the records asked for.** Filed with a self-contained repro. This is the floor under everything that
   still costs: a z16 view pays 14.2 MB for ~4 MB of content, and it is why Enschede's first paint went
   from ~1.6 s (whole file) to ~6.3 s (paged). **⚠ Four hypotheses about its cause were falsified by
   measurement** — descent-sharing, batch amortisation, miss cost and tile LOCALITY (a Hilbert reorder is
   marginally *worse* than a plain rewrite). Only the 4× itself survived every control.
2. **⚠ `data-refresh.yml` still cannot run**, and it is older than tonight: it merges chunks into TWO
   halves while `data/coverage.toml` has named FOUR regions since §6f F3, so `publish-release.sh` fails
   building the release index AFTER uploading gigabytes. The recipe is noted beside the step. It DOES
   rebuild the overview now, so that gap is closed.
3. **The z11–z13 DETAIL gap** — instant but coarse (z≤10 content at ~8 px error). §6i O3b is the fix and
   is bounded by loft#729: every cell size costed lands at 22–54 MB per viewport while a key costs this.
4. **⚠ The paged base map works only because the data repos share the app's origin.** Cross-origin with
   `ACAO` but no `Access-Control-Expose-Headers` — what GitHub Pages sends — the same code reads 2
   requests, 0 bytes, a blank map and NO error. `cors_host_gate` is green because `range_server.py` models
   a *correct* CORS host, which Pages is not. **This undercuts D2's off-origin plan for Western Europe.**

⚠ **The installed loft moved mid-session, 2026.7.2 → 2026.8.0** (2026-08-02 19:59, md5 `13311104…`,
byte-identical to `../loft`'s build). Everything above was re-verified on it, including a wasm rebuild
(identical sources, 1 408 411 → 1 404 720 bytes — the drift the sources sidecar deliberately does not
hash). Anchor any toolchain claim to mtime + md5, never `--version`.

---

## 0a. The previous rung (2026-08-02, earlier) — the country BASE MAP going live

### What is live (dataset `v2026-08-02`)

⚠ Superseded in one respect by §0: `enschede` is no longer among the blocks a visitor can resolve to, and
the index leads with `nl-overview`. The rest stands.

| | |
|---|---|
| roads | four blocks, 502 MB, same-origin on Pages, paged |
| names | `nl.names.store` 36 MB, searched offline |
| **base map** | **2.75 GB across FOUR Pages data repos** — `routing-data-nl-{west,midwest,mideast,east}`, read cross-origin by byte range (206 + `access-control-allow-origin`, verified per repo) |
| site total | 585.7 MB of a 950 MB budget (62%) — the overview added 20.6 MB |
| release | `data-v2026-08-02`, 3.1 GB, every asset re-read for a 206 and its exact size |

### The three rules F3/F4 added, each of which cost something to learn

1. **A feature is keyed at the finest tier whose cells its bbox spans ≤ 2 of, at the cell holding the
   bbox's MINIMUM CORNER.** That bounds its reach to one cell, in one direction, so a reader pads the low
   side only and paging is EXACT: missed features at z16/z14 went 7/5 → **0/0**, keys asked 111 → 69, and
   the store is the same size. Regions measure zero missed.
2. **A region carries a 0.10° MARGIN of its neighbours**, wider than a padded z14 viewport, so no viewport
   ever shows a seam: a z14 view centred on a cut draws 61 631 features from ONE region — the count the
   whole country gives. Four regions rather than three because three cannot hold that margin under the
   cap. ⚠ **Roads are cut WITHOUT the margin** — the client stitches road blocks and a duplicated way is a
   different match, not a slower one — so a region's two stores do not describe the same ground.
3. **Read mode belongs to the STORE**, not to the camera's block (the fix above).

⚠ **`store_persist_bind` over an EXISTING file keeps the old image and returns `true`.** New counts
printed, fresh mtime, previous map still on disk. It produced a wrong region cut that only reading the
extent back caught. Every persisting tool now refuses an existing target (`#PERSIST FAIL`) — **delete
before you regenerate.**

⚠ **A tiered base store's EXTENT is not a geographic bound.** A 256 km tile makes all four region extents
read the whole country, so selecting a block by base extent picked an arbitrary region and **Den Haag and
Rotterdam rendered as two lines** while the gate stayed green on aggregate. Selection is on the ROADS
extent. `build_index.sh` still writes a base extent — treat it as a size, not a location.

### Next, in the order the evidence favours

1. **Merge the branch** (above), then re-run `tools/nl_live_gate.sh` — it is F5 now: it asserts the map is
   DRAWN, which is the check whose absence let a blank map ship.
2. **Optimisation, which is what the maintainer wants next.** A z13.68 viewport costs **68 MB** and 124 MB
   over the Randstad — measured, and the dominant term is not geometry: a keyed read costs ~100 kB whether
   or not the key exists, so the bill is asking, not receiving. Levers, cheapest first: a coarser
   `LAYOUT_CELL` (trades probe count against over-fetch, has an optimum worth measuring), a cheaper
   absent-key probe in loft's paged loader (`layout_page_probe … pageload` is a ready reproducer), and
   generalisation — a zoom pyramid — which is the only thing that helps a zoomed-out view.
3. **Western Europe** — `PLAN-SCALE` §6h says the read path scales and the PUBLISHING does not, measured:
   20.5 GB of source against NL's 1.40 GB (14.7×) projects to a 30 GB base map and ~58 regions. Three
   patterns break first: the roads stop fitting the app's own site (3.5 GB vs 0.95 GB), one Pages repo per
   region becomes 58 (this is where D2/R2 stops being optional, ~$0.61/month), and the 62-block ceiling in
   `block_overlap.loft` binds. §6g has the automatic region planner design, prototyped.

⚠ **Local browser gates run with `SITE_LOCAL_ONLY=1`**, which names only the blocks that ship with the
app. Without it they reach the internet for an off-site base map and do a country's work to check a
city's invariants — `map_render_gate` ran past a four-minute guard. Re-verified on a quiet box, because
the first measurement was taken while a stranded headless chromium of mine sat at ~1000% CPU.

| | |
|---|---|
| `main` | PR #39 merged 2026-08-01 09:27Z; `deploy` success. Protected — PR + green `build-test`, never a direct push |
| in flight | **`full-nl-design`** — docs only (§6f + this section), pushed, not PR'd |
| data | release **`data-v2026-08-01`** (2.6 GB, every asset verified before the index went up); site index `v2026-08-01` |
| verified live | `browser/cdp_nl_live.mjs` driven against the DEPLOYED site: Amsterdam → `nl-west`, no base map, 29-point route, **17.7 MB of 222 MB by Range (8.0%)**, search finds "lonneker" |

### What ships

| | |
|---|---|
| **roads** | `nl-west` 233.4 MB + `nl-east` 263.9 MB, same-origin on Pages, `read_mode = "paged"` |
| **names** | `nl.names.store` 36.1 MB — 296 474 streets + 12 700 places, searched offline |
| **base map** | Enschede only (20.8 MB). The NL base is **2 GB and does not fit** the ~1 GB Pages cap, so it is on the release for the native server and offline use. Outside Enschede you route on a plain background |
| **site total** | 560.5 MB of a 950 MB budget (59%), measured every build by `tools/site_size_gate.sh` |

### Three rules that are load-bearing, and cost a session each to learn

1. **The index is the contract.** `tools/fetch-site-blocks.sh` verifies every download against the
   sha256 in the committed index, and the Pages deploy runs it. So **a republish without regenerating
   and committing the index turns every deploy red** — do both in one change. (The strictness is
   deliberate: a truncated block otherwise presents as "routing is broken", not as a missing file.)
2. **Hosting is per STORE, not per region.** NL's roads ship beside the app and its base map does not.
   `data/coverage.toml` uses `base_url_base` for that; `build_index.sh` emits `base: null` in the SITE
   index and the app treats it as a supported state (`LAYOUT = ''`), not an error.
3. **A schema change makes older blocks read GARBAGE, not empty** (loft#700). `TRoad.flags` went u8→u16
   for the network bits, which is why every block was regenerated. `build_index.sh` and `access_gate.sh`
   refuse a block whose `.dschema` is stale.

### Where to go next

`PLAN-SCALE.md` **§6e** is the Western Europe design, written from NL's measurements. Short version: the
**client already streams and already scales** (a viewport is 75–190 kB whatever the store's size); the
**GENERATOR does not** (~350 bytes RSS per feature ⇒ 130–270 GB for WE); so never build a store that big —
one region per run, fed by a single `osmium extract --config` pass, which is the block structure C4/C5
already specify.

Step 1 is **done**: `tools/build-base-chunked.sh` + `trim_base.loft` + `merge_base.loft`, proven lossless
(Enschede n=2 exact; NL n=4 within a per-seam bound), and wired as a CI matrix in `data-refresh.yml`.

**F1 and F2 are DONE (2026-08-01). F3 is next, and F1's measurements changed what it has to do.**

| | what | state |
|---|---|---|
| **F1** ✅ | **page the layout in the kernel** — `store_load_keys(layout, url, layout_cell_keys(bbox, LAYOUT_PAD))`, a working set with its own marks, driven by a per-STORE read mode (`__baseReadMode`, kernel line 7) | built; the app draws a base map it never downloaded whole, over real 206 Range requests |
| **F2** ✅ | **re-`expose` as the working set grows** — the pin comes off around every load and back on after; JS re-reads the handle per view | built, **and the risk is disproven by measurement**: 13 viewports, per-viewport cost 195 → 162 ms (0.83×), bracket balanced 13/12 |
| **F3** ✅ | cut NL into regions **and re-bin the base map**. It came out as **FOUR** regions, not three — see below | built and verified locally; blocks are gitignored and NOT published |
| **F4** ✅ | publish the four base blocks to data repos and move `data/coverage.toml` | **done** — release `data-v2026-08-02` (3.1 GB) + four Pages data repos, each verified by a cross-origin ranged GET (206 · ACAO · exact size). ⚠ the LIVE site still serves v2026-08-01 until this branch reaches `main` |
| F5 | **assert the map RENDERS** in `nl_live_gate` — against the deployed site, once main moves | not started, and it is the check that would have caught the blank map |

**Where the data lives now.** Roads (4 blocks, 502 MB), the name store and the app ship on the main Pages
site — 565 MB of a 950 MB budget. The base map (2.75 GB) is four Pages DATA REPOS,
`routing-data-nl-{west,midwest,mideast,east}`, read cross-origin by byte range; each holds a workflow that
downloads its block from the release, because GitHub rejects committed files over 100 MB.
`base_cors = true` in `data/coverage.toml` is what lets the site index NAME those URLs — it stayed silent
for the release, which serves ranges but no CORS header.

**F3 in one line: paging the base map is now EXACT, and no viewport ever shows a seam.**

* **Exactness is two generator rules, and it is free.** A feature is keyed at the finest tier whose cells
  its bbox spans at most 2 of (tiers ×8: 500 m → 4 km → 32 km → 256 km, the tier riding in the key), at
  the cell holding the bbox's **minimum corner** — so it reaches one cell *up* and never down, and the
  reader pads one side. Missed features at z16/z14: **7/5 → 0/0**. Keys asked per z16 viewport: 111 → 69,
  93% of them hits (was 65%). Store bytes: **unchanged**. Country rebuild conserves exactly — 17 290 495
  features, the published total.
* **No seam, by DATA not by stitching.** Every region's internal sides are widened by a **0.10° margin**,
  wider than a padded z14 viewport (±0.0944°). A viewport centred on a cut draws 61 631 features from ONE
  region — the same count the whole-country store gives. Before the margin, one region answered such a
  viewport with 54% of it.
* **Four regions** (cuts 4.7 / 5.4 / 5.9), because three cannot hold that margin under the 900 MB cap —
  the eastern one lands at 957 MB. Base 555 / 794 / 627 / 775 MB; roads 104 / 129 / 107 / 162 MB, split
  from the country block with 2 785 476 ways and 234 253 barriers conserved exactly. ⚠ **Roads are cut
  WITHOUT the margin** — the client stitches road blocks and a duplicated way is a different match, not a
  slower one. The two stores of one region no longer describe the same ground, on purpose.

⚠ **Two silent defects this rung found — read these before generating or publishing anything:**

1. **`store_persist_bind` over an EXISTING file keeps the old image and returns `true`.** The tool prints
   the new counts, the mtime updates, and the file still holds the previous map. It produced a wrong
   three-region cut that only reading the extent back caught. Every persisting tool here now refuses an
   existing target (`#PERSIST FAIL`); **delete before you regenerate.**
2. **A tiered base store's EXTENT is not a geographic bound.** A tier-3 tile is 256 km wide, so all four
   region extents read lon 2.39..7.21 — the whole country, four times. Selecting a block by base extent
   picked an arbitrary region and **Den Haag and Rotterdam rendered as two lines**, with the gate still
   green on aggregate. `baseUrlsFor` selects on the ROADS extent and reads the base URL off that region.
   `build_index.sh` still writes a base extent into the index — treat it as a size, not a location.

**Western Europe: the read path scales, the PUBLISHING does not (`PLAN-SCALE` §6h).** Measured, not
guessed — Geofabrik's thirteen WE countries are 20.5 GB of source against NL's 1.40 GB, **14.7×**, which
projects this session's blocks to a **30 GB base map (40.5 GB with margins), 3.5 GB of roads and ~58
regions**. Three patterns break before any of that is buildable: the **roads stop fitting the app's own
site** (3.5 GB vs 0.95 GB, so every store moves off-origin), **one Pages repo per region becomes 58**
(this is where D2/R2 stops being optional — 40.5 GB is ~$0.61/month), and the **62-block ceiling in
`block_overlap.loft` binds** at ~58 blocks. Each is a small known fix; all three are prerequisites.

**Also scoped rather than started: `PLAN-SCALE` §6g — planning regions AUTOMATICALLY.** NL's
four regions were cut by hand off a 1-D longitude profile, which does not survive Western Europe: a
longitude cut cannot make a dense COLUMN smaller, and London / Paris / the Ruhr / Milan each can put a
strip over the cap alone. The design is download → osmium → **count coords per 0.05° cell** → kd-split on
weight → build only the plan; the analysis reads the geojsonseq exports, so nothing is built twice.
Prototyped on the real NL grid it beats the hand cut (max 727 MB vs 794, +33% vs +35% duplication) and
splits in BOTH axes. ⚠ **It fixes region SIZE and not per-viewport COST** — an Amsterdam z14 viewport is
already 21.8 MB of geometry and London will be several times that, which no region plan touches. Measure
an Île-de-France or Greater London extract before committing to WE.

⚠ **The shipped city block is still keyed the OLD way**, and that is the one loose end F3 leaves.
`browser/stores/enschede.layout.store` predates the tier rules, so the new reader's low-side padding is
not exact against it: its residual grew from 7 features to 12 of 71 183 (0.15%), and
`base_paged_gate` phase 1 bounds it at 20 as a regression guard. The four NL regions measure **zero**.
Retire it by regenerating that block (`build-blocks.sh` + `build-base.sh` for its bbox → copy the layout
store into `browser/stores/` → refresh the index); it was not done here because it also re-cuts the
Enschede ROADS block, which re-baselines route fingerprints and the render pixel hash — a cascade that
has nothing to do with NL.

⚠ **Two §6f premises were measured WRONG while building F1, and F3 is where they get fixed.** Both on
`blocks/nl-west.base.store`, with `tools/layout_page_probe.loft`:

1. **A viewport is not 75–190 kB — it is 10.3 MB at z16 and 68.4 MB at z14.** The old figure multiplied
   the store-wide average tile (9.1 kB, i.e. a RURAL tile) by an unpadded 8–20-cell window; a real
   padded z16 viewport is 84 cells of CITY. The marginal cost is ~110 kB per key against ~31 kB of
   geometry — and **84 keys that hold nothing still cost 9 MB**, which says most of it is the per-key
   probe. `LAYOUT_CELL` (500 m) is finer than the read path can pay for.
2. **No affordable padding is exact.** A layout feature is keyed by its first vertex and never clipped,
   so it overhangs its cell; a paged load cannot consult the extent of a tile it never fetched. At z16,
   exactness needs 11 cells of padding (864 tiles) and at z14 fifty (13 661 — the region).
   `LAYOUT_PAD = 1` is the knee (85% of the misses removed for 1.7× the tiles) and is a **compromise**:
   `base_paged_gate.sh` measures the residual at **0.07% of features**, worst single drop 6.

   *Both* are fixed by the same generation-side change, which is why F3 owns it: **bin each feature into
   a tile whose cell CONTAINS it, with coarser tiers (×8) for the ones that do not fit.** Then a feature
   spans ≤ 2 cells at its own tier, so pad=1 per tier is EXACT; each feature is still stored once; and a
   low zoom reads only the coarse tiers, which is also the answer to 68 MB.

**New gates** (both in `make test-map` / `make test-native`): `tools/base_paged_gate.sh` runs the same
13-viewport camera path twice — base map WHOLE vs PAGED — and compares what got DRAWN per kind, because
a paged read that silently drops features is invisible from every other angle; `tools/paged_gate.sh`
gained the native half, which pins the fetch window's residual against the shipped block.

⚠ **`browser/build-store-kernel.mjs` was hashing only three of the kernel's five source trees** —
`lib/basemap` and `lib/web` were missing, so a change to the PTile schema or the layout grid reported the
committed wasm CURRENT. Fixed here; that is the silent direction of the check HANDOFF §0 already warns
about.

Then §6e's list, which is about Western Europe rather than NL:

| | what | why it matters |
|---|---|---|
| a | **the workflow has never actually run** | `data-refresh.yml` is `workflow_dispatch`-only and its first firing will publish. Trigger it once with eyes on it |
| b | the 4-features-per-seam chunk loss | NL n=4 loses 5 tiles / 12 features. Hypothesis: a multipolygon straddling a seam. Untried fixes: `osmium extract --strategy=smart`, or a larger `MARGIN` |
| c | **raise the 62-block cap** | `block_overlap.loft` masks cell owners one bit per block. §6e's chunking puts WE at 34–68 blocks, so it may bind. Fix: count per PAIR |
| d | **price D2** | 44–88 GB is past Pages and past a release asset. `cors_host_gate.sh` already passes against a CORS origin, so the path is tested — this is a cost question, and it is what would put the base map on the map |
| e | R2 (elevation) | now costs its own full regeneration (~35 min for NL) — see PLAN-RESTORE §4. Bits 11–15 of `flags` are free, so no further widening |

⚠ **The cron in `data-refresh.yml` is off deliberately.** Publishing replaces data a deploy verifies
against, and loft is built there from `loft-lang/loft` **main**, where the fixes this repo needs are
routinely fixed-pending-merge. Both reasons are in the workflow header.

---

### The previous rung (2026-07-31) — PR #30, for context

PR #30 carried five fixes and their gates. `main`'s tree is byte-identical to the commit the full local
matrix ran on, and the **Pages deploy is live**: the site serves `features: 49613` roads (was 25 971) at
`sha256 3012840c…`. Two of the five were found by *running* the gates rather than by the reports that
started the work — see "The gates found two defects in themselves" below, which is the part of this
section most worth reading if you are about to trust a green run.

### What landed

Three separate map defects were reported: *"there are paths that are blocked (fences) and not allowed
for public walking, but they show up as normal paths and are probably used for routing too"*, plus a
missing dirt road. They had three different causes and only two were ours.

1. **`166ddc8` — closed ways were routable.** A stored road is 3 bytes (class, flags, vertex count) and
   the corridor read rebuilt every way with `access:"" bicycle:"" svc:""`, so `bike_never`/`foot_never`
   — which do test those — could never fire on a tile-sourced way. 43 ways tagged `access=private|no`
   in one 1.8×3.6 km box were stored as open. The 6 free bits of the flags byte now carry them
   (`RF_*` in `routing_kernel.loft`). Same commit: `track` had been folded into `path`, so every dirt
   road was drawn at `path`'s minZoom 15 instead of `track`'s 14 — present in the data, invisible at
   zoom 14. It has class 12 now.
2. **`9dd5a33` — barrier nodes.** A gate across a path is a NODE and both fetch paths took ways only.
   Now `w/highway n/barrier` + point export → `TTile.barriers` → `build_graph_barriers`.

**Viekerweg, the third report, is not ours**: OSM has it as `highway=track, motor_vehicle=no` with no
`access`/`foot`/`bicycle` restriction, so the router is faithful to the data. It needs an OSM edit.

Three more commits came out of running the gates over the above: **`ada89ba`** deletes the corridor's
dead bbox prologue (superseded by `corridor_cell_keys` since `8ce7659`, and still being compiled in —
the wasm drops 6.6 KB; route-identical), and **`9d7de44`** + **`8c47628`** fix the gate defects below.
**`97262c4`** rebuilds `browser/store-kernel.wasm` for `ada89ba` — see the trap list.

### The one thing most likely to mislead you

**GitHub Pages DOES serve byte ranges.** This repo said the opposite until 2026-07-30, in
`PLAN-SCALE` D2, `data/coverage.toml` and `tools/cors_host_gate.sh`, and that claim is why the
Netherlands blocks live in a GitHub *release*. It was measured against `python3 -m http.server`, which
ignores `Range` and returns the whole file, and python's answer was recorded as GitHub's. Re-measured
against the live site: **206, 16 bytes asked → 16 transferred, correct bytes at three offsets.** All
three docs are corrected on `main`. Consequence: **D2 is not a wall and no bucket is needed** —
what limits GitHub hosting is SIZE (Pages ~1 GB/site; NL roads 504 MB fits, roads+base 3.2 GB does not).

### Regenerating a block is now MANDATORY, not optional

`TTile` gained a `barriers` collection, and a store written before it **does not read as empty — it
reads garbage** (a count came back as `20981984713`). That is
[loft#700](https://github.com/loft-lang/loft/issues/700): `store_load` ignores the sidecar's schema hash
and maps old records at the new stride. Every block in the tree is already regenerated;
`tools/build_index.sh` and `tools/access_gate.sh` both refuse a block whose `.dschema` lacks
`barriers@`, so a stale one cannot reach the app.

### The gates found two defects IN THEMSELVES — read this before trusting a green run

Nobody reported these. They surfaced because the suite was run twice in one session, hours apart, and
the second run disagreed with the first over data that had not changed.

1. **`9d7de44` — `index_fresh_gate.sh` failed on the CALENDAR, not on staleness.** It regenerated
   `coverage.json` and demanded byte-identity, but did not pin `DATASET_VERSION` — which
   `build_index.sh` defaults to **today's UTC date**. So it compared *today* against the day the index
   was committed: green on that day, **red every day after**, reporting "STALE" about an index that
   described its blocks perfectly. Caught because `make test-native` passed at 22:25 UTC and failed at
   05:23 UTC with nothing changed between. The version is pinned now, and separately checked against the
   release tag in `data/coverage.toml` so pinning costs no real signal.
2. **`8c47628` — the root cause: a gate REWROTE A COMMITTED FILE on every run.** `build_index.sh`
   defaults its output to the committed `browser/coverage.json`, and three gates (`map_render`,
   `cross_block_browser`, `cors_host`) call it with **no argument**. So every `make test-map` restamped
   it. *Nobody ever chose `v2026-07-30` — a gate run on the 30th wrote it.* Pinning in (1) stopped the
   false failure but left the mutation: the tree came back dirty and a `git add -A` would have committed
   a silently renamed dataset. Found only because `gh pr create` warned "1 uncommitted change" about a
   file already restored once by hand.

**The rule they cost:** *a generator over unchanged inputs must be idempotent, and a gate must not write
to the tree it is checking.* `version` is a RELEASE NAME, not a measurement — everything else in that
index is measured out of the blocks and changes only when they do. It now resolves as: explicit
`DATASET_VERSION` → the name the existing index already carries → today's date for a first generation.
`publish-release.sh` passes the version from the tag it publishes under, so the index always names its
own release (the pairing `index_fresh_gate` asserts; it used to hold only by coincidence of the date).

⚠ **A gate that cries wolf on a clock is worse than no gate** — it trains you to skip the run that
finally means it. If a gate here fails, check whether anything it depends on is a *wall clock*, a
*mtime*, or a file the suite itself writes, before you go looking at the data.

**A third one of the same family turned up an hour later, and it is the worst of the three.**
`map_render_gate.sh`'s "is the shipped kernel wasm current?" check was
`find <kernel srcs> -newer browser/store-kernel.wasm` — and **git does not preserve mtimes.** Right
after PR #30's merge checkout the wasm was written at `08:03:23.568` and `routing_kernel.loft` at
`08:03:23.588`: 20 ms later, same checkout, nothing edited, and a correct wasm was reported STALE. The
spurious failure is the harmless direction. **The other direction is silent** — a genuinely stale wasm
that a checkout happens to write last PASSES, and catching that is the entire purpose of the check, on
the one artifact in this repo that is committed and built by hand. It now compares a **sha256 of the
kernel sources**, written to `browser/store-kernel.wasm.sources` by `build-store-kernel.mjs`
(`--print-source-hash` gives the gate the same function, so there is one implementation). Verified to
fail three ways: an edited source, a NEW source file the wasm never saw, and a missing sidecar.

⚠ **The sidecar catches SOURCE drift, not TOOLCHAIN drift.** Rebuilding unchanged sources on the
2026-07-31 08:10 loft produced a **different wasm** (1 320 670 → 1 327 196 bytes) with identical
behaviour. Hashing the compiler in too would fire on every reinstall — which happens several times a
day here — so it is deliberately not done; just rebuild the wasm when you change loft under it.

### New in `tools/`

- **`access_gate.sh`** (in `make test-native`) — the legality gate. Fixtures where the SHORT way is
  private / gated / stiled and the detour is longer, each with a control that removes the tag or node
  and checks the shortcut IS then taken, so it is verified to fail. Plus one stile asserted from both
  sides: walking 682 m *through* it, cycling 1127 m *around* it.
- **`access_probe.loft`** — `count` (what a block carries) and `route` (metres of a route on restricted
  ways, and where along it).
- `index_fresh_gate.sh` — `browser/coverage.json` is a COMMITTED generated file (the Pages deploy job
  has no loft to measure extents with); this regenerates it **at the committed version** and requires
  byte-identity, then checks that version against the release tag in `data/coverage.toml`. Both of its
  controls are verified to fail (a rotted extent; a version out of step with the tag).

### Two loft issues filed from this work — BOTH FIXED within a day

- [**#699**](https://github.com/loft-lang/loft/issues/699) `sev:medium` — a `vector` parameter with a
  `= []` default panics the parser. Why the API is `build_graph_barriers(ways, barriers)` and not a
  defaulted argument. **Fixed** (`../loft` `d8dde3e9`); repro re-run on the 08:10 binary, it now prints
  `both=6 defaulted=3`. The API can be simplified whenever someone wants to — it is no longer forced.
- [**#700**](https://github.com/loft-lang/loft/issues/700) `sev:high` — the silent store corruption
  above. **Fixed** (`../loft` `2ba50550`, *"check the store's recorded layout before reading it whole"*).
  ⚠ This does **not** retire the regeneration rule: the fix makes a stale store *audible* rather than
  garbage, and every block here is already regenerated. Keep the `.dschema` checks — they are what stops
  a stale block reaching the app on a loft that predates the fix.

⚠ Both are `fixed-pending-merge` — present in the **installed** binary, not necessarily in loft `main`.

### Still open on this work (also PLAN-SCALE §9)

- `oneway=` is still dropped by the store — the flags byte is **full at 8/8**, so it needs a wider
  field and therefore a regeneration of every block.
- **`server.loft`'s Overpass fallback corridor is still ways-only**, so it walks through gates. The
  tile path (what the app uses) is fixed.
- A barrier tagged BETWEEN way vertices is dropped (it matches no graph node).

### Traps this work walked into — do not re-pay them

- **`nohup … &` reports "completed" the moment it detaches.** I started a second country build against
  the same output path; the older, stale-recipe run finished last and overwrote the good block. I then
  chased it as a loft scale bug through two synthetic sweeps. Check `ps` before re-running a long build.
- **`build-blocks.sh` resumability was keyed on mtimes, not on the recipe** — it happily reused a
  way-only `geojsonseq` after the filter changed and produced a "successfully regenerated" country
  block with zero barriers. Now keyed on a recipe fingerprint; `split_block` asserts CONSERVATION.
- **A cost tier for a POINT needs a notional length.** Every tier here is per-metre. Charging a barrier
  one metre's worth (20 000) changed no route anywhere, because a 1 120 m detour 220 m off the drawn
  line costs ~740 000. Both barrier tiers are now "what would this cost as a stretch of way?".
- **A drawn point is an ANCHOR.** A test trace whose point sits on the barrier pins the route through
  it, and the assertion tests nothing.
- **Piping a script to `tail` replaces its exit status.** `overpass_fetch.py` correctly exits 1 on a
  failed chunk; `| tail -6` turned that into 0 and I built a block from a half-fetched region. Paid
  again on 2026-07-31 (`make test-native | tail -70` — the run really was green, but the pipeline said
  so for the wrong reason). Use `set -o pipefail`, or read `${PIPESTATUS[0]}`.
- **A kernel edit does NOT reach the browser on its own.** `browser/store-kernel.wasm` is committed and
  rebuilt BY HAND (`node browser/build-store-kernel.mjs`). Editing `routing_kernel.loft` and re-running
  `test-native` proves nothing about the app; `map_render_gate.sh` catches it ("STALE: predates kernel
  sources") **only if you run `make test-map` after the edit** — which is exactly the run you skip when
  the change looks inert. A dead-code deletion still shrank the wasm 6.6 KB, so "it cannot matter" was
  wrong about the bytes too.
- Overpass's public mirrors were timing out and erroring on 2026-07-30. **The osmium path is the
  documented one and takes seconds** — `tools/build-blocks.sh` over the cached
  `~/.cache/routing-blocks/*.osm.pbf`. It also revealed the old Enschede block was missing whole road
  classes (no `service`, no `unclassified`): 25 971 ways → **49 613**.

---

---

## 1. Where things stand

The **standalone/serverless browser app runs in a real browser** (`browser/store-app.*`, plan of record
`PLAN-BUILD.md`): it fetches the two loft stores by URL (`store_load_url_trusted`), runs the **loft-wasm
kernel** (`client/web_basemap_kernel.loft` → `loft --html`) for the matched route, and needs **no server**.

**`PLAN-PERF.md` §0 has nothing open.** Steps 1–16 and 20–22 are done; **19b is ⛔ closed on measurement,
not skipped**, and **18 is ⏸ deferred on a DEPLOY constraint, no longer on a missing loft capability**
(see §2 below). **`PLAN-EDIT.md` E0–E7 are done** — the app can reshape a sketch, not just append (§2a).

**Everything is on `main` (`4e693a3`) and nothing is in flight** — PR #30 merged 2026-07-31, see §0.
`main` is protected: PR + green `build-test`, never a direct push. (An earlier revision of this line
said work was parked on `fix-access-tags`; that branch is merged and deleted.)

### The numbers, `CPU_THROTTLE=4` (≈ a phone — always profile with it; desktop flatters ~4×)

Quiet box, medians of 6, spreads 1.0–1.1×:

| interaction | before | now | |
|---|---|---|---|
| **view** (pan past the loaded box) | 946 ms | **146 ms** | 6.5× |
| **pan frame** (camera moved, no reload) | 76 ms | **0.6 ms** | 127× |
| **cold match** (first click / corridor miss) | 6370 ms | **1450 ms** | 4.4× |
| **warm match** (one point moved — what users do) | ~880 ms | **343 ms** | 2.6× |
| JS objects retained for geometry | 239,135 | **4,609** | −98% |

**Every shipped change is route-identical**, proven by `tools/match_parity.sh` and (for anything touching
the graph) `tools/tile_border_gate.sh`. The two route-AFFECTING changes ever accepted — step 22's ladder
and nothing since — were gated on a 26-sketch corpus with **0 worse accepted**.

### The six structural changes behind those numbers

1. **loft owns the loop** (steps 4–8) — `loft_start` once, never returns; stores, corridor `Graph` and
   `MatchState` live across commands. It used to run the one-shot model loft explicitly *rejected*: a
   full match per click, a phone frozen 4.2 s at a time.
2. **loft is out of the view path** (steps 9–13) — JS reads the layout store from wasm memory through
   @PLN105's `expose` bridge; `view` emits roads only, **no layout text at all** (was 4.25 MB/view). A
   per-tile feature extent (§7g) then lets a viewport read **6% of the tiles**.
3. **The match ladder** (step 22, and §7p) — cell-tube corridor first, escalating to the fat bbox when a
   margin-relative gate rejects it. ~65% fewer ways when accepted. **Both consumers now run it**: the
   browser kernel and, since §7p, `server/server.loft`'s TILE branch — slotted inside that branch so the
   server's widening loop and its tiles-replace / Overpass-accumulates policy are untouched, with the
   **Overpass path deliberately left OFF the ladder** (the corpus does not cover it). `tier_ok` +
   `TIER_*` + `DEV_MARGIN_K` live in `routing_kernel` for that reason — the server must not pull in
   `map_kernel`'s basemap deps to reach a corridor-quality gate.
   ⚠ The gate's K was swept on `cycling_road`; the server defaults to `walking_paved`, so it was
   **re-swept before wiring** (§7p): K=6 gives 0 worse there too, first bad acceptance at K=9. Worth
   ~13% of a server tile match — less than on cycling, so size it before spending.
4. **JS stopped COPYING the store** (step 14, §6c) — a `vector<Coord>` is *already* an interleaved
   `Int32Array`, so the renderer reads coordinates straight out of wasm memory instead of materialising a
   viewport as 239k JS objects. This is the fix "pre-project into typed arrays" would have missed — it
   would have been a cheaper copy, not no copy. Streets cannot follow (the matcher *iterates* the roads
   store and loft cannot iterate a pinned one — ~230 ms per re-expose), so they parse into a flat column.
5. **Block raster cache** (step 15, §6d) — the base map is baked into 512-px world-pixel blocks and a pan
   blits them. ⚠ It **snaps the render origin** to a whole device pixel and can never be pixel-identical
   (Chromium's rasterisation is not invariant to canvas dimensions — *proven*, §6d), so its gate is three
   equalities plus a bounded delta. **Anything replacing layer data must call `map.invalidateBlocks()`.**
6. **The matcher's own cost, attacked directly** (§7i–§7m) — edges reference their source way instead of
   copying its 11 text tags; costs computed per way, not per edge; the node-dedup key is a packed i64
   rather than formatted text; `nearest_nodes` is one pass, not four; anchor candidates are memoised.
   Cold match 3327 → 1450 ms across those, every one route-identical.

✅ **The growing line is delivered** (§6b(2)) — the route was *emitted* per stretch in travel order but
nothing *rendered* it that way. `runKernel` now takes an opt-in line sink drained per yield in a
microtask (before paint); `map` accumulates stretches by slot. `DESIGN.md` §5 and `PLAN-MATCH` describe
actual behaviour again. Two things its gate then surfaced: `remove_spurs` prunes ~60% of the raw stitch
(the line visibly tightens at the end), and step 22's ladder **emits the route twice** when it rejects the
tube tier (§6b(3)) — which was both a stale number in step 16's row and a live rendering defect.

---

## 2. What is CLOSED (and the one that is only DEFERRED) — do not re-open without new evidence

Six things were investigated and **not shipped**. Each is closed by a measurement, with the probe kept so
the verdict can be re-checked rather than re-derived. *This section exists because the expensive mistake
is re-opening a door someone already measured shut* — and, for the one that is only **deferred**, walking
past it after it has quietly opened.

| | verdict | evidence |
|---|---|---|
| **18 — `par` over the stretches** | ⏸ **DEFERRED on the DEPLOY host — the loft capability LANDED (2026-07-29)** | Today the app's wasm has `shared=false`, no TLS exports and Rust's no-threads std linked in (re-verified 2026-07-29), so `par` is a literal no-op *in it* — because `loft --html` only picks the threaded runtime for a program with a **reachable `par`**, and the kernel has none. **⚠ UPDATE 2026-07-29 — that capability LANDED (@PLN117) and is verified on the installed loft: a `loft --html` bundle dispatches `par` over 8 Web Workers with the interpreter's value (PLAN-PERF §6e).** Our kernel is still unthreaded only because it has no reachable `par`. And **`tools/wasm_threads.mjs` was BLIND** — it read the SHARED flag from the memory *section*, but a threaded wasm IMPORTS a shared memory and defines none, so it passed a genuinely threaded bundle as single-threaded; now fixed (import section + TLS exports + three self-test controls). It is a regression gate on our artifact, **not** the cue for step 18: the cue is a **COOP/COEP deploy host**, which GitHub Pages is not. §6b B's determinism design (order the source before par; hash iteration is unordered; `gen` is loop-carried; keep reductions out of the workers) is kept for exactly that day. ⚠ Still check the DEPLOY side then: Tier 2 needs COEP/COOP headers, and GitHub Pages cannot set them — a service-worker COEP shim may be needed. |
| **19b — persist the graph per tile** | ⛔ **not worth it** | The union is only ~13–21% cheaper than building: it must still hash ~34k part-nodes against a build's 44.7k vertices, copy every edge and rebuild the CSR, and the parts duplicate just 1.5% of their nodes so no cleverer format helps. ~8% of a cold match for a store-format change, a redeploy and the plan's riskiest row (§7a(2)). |
| **`spatial<T[x,y]>` for `nearest_nodes`** | ⛔ **built, measured, reverted** | Correct (routes byte-identical) but a net loss: **+275 ms** of per-corridor index build for **zero** match improvement. Its value was finding that `nearest_nodes` was not the bottleneck at all (§7l). |
| **Pruning the anchor search** | ⛔ **corpus-rejected** | −28% at a 400 m cap but routes get *longer* by up to 62%; the corpus's own `dev_max` reaches ~1056 m so any useful cap severs legitimate paths, and every cap loose enough to preserve routes is inside the ~3.4% noise floor (§7n). |
| **Sharing anchor searches across a span** | ⛔ **corpus-rejected** | SPAN=2 verified to reproduce today's behaviour exactly; every span ≥3 was WORSE — sketch 11 gained **855 m of bridging**, sketch 19 grew **+79%** — because a block path optimised end-to-end stops passing close to the intermediate taps (§7o). |
| **A cheaper `denoise_anchor`** | ⛔ **both levers closed** | Narrowing each search (§7n) and sharing searches (§7o) are both rejected. Its ~131 ms is the honest cost of centring each anchor on its own neighbourhood; anything cheaper is a **different matcher**, not a faster one. `tools/corpus_anchor.loft` is the gate for whoever disagrees. |

---

## 2a. ✅ DONE — the rough-layer editor is ported (2026-07-23)

**The standalone app can now RESHAPE a sketch, not just append to it.** `DESIGN.md` §1's primitive set is
live: **place · drag · insert (tap + sweep) · delete (double-click / select + Delete) · contiguous-range
multi-select + bulk delete · undo/redo · shift-drag box select.** Plan of record and full write-up:
**[`PLAN-EDIT.md`](PLAN-EDIT.md)** — steps E0–E7, all done, its §9 is the definition-of-done check.

**The shape of it.** One module, `browser/rough.mjs`, owns the sketch and every input that can change it.
Three chokepoints carry the invariant (*one road in, one road out*): **input dispatch** (one pointer
handler classifies pan · move · box and delegates the camera to `map.dragTo`), **`commitEdit`** (the only
path from a mutation to a redraw, a match request and an undo record), and **`KernelQueue`** (the only road
to the kernel — one job at a time, latest-wins per key). `map.mjs` draws the sketch in the overlay pass
inside the snapped-origin block; it owns pixels, the layer owns state.

**Three defects that predate the work, found by probing and now gated:**
- a **pan drag appended a spurious rough point** (two files bound input and neither knew about the other);
- a **click during a match was silently dropped** — the drawn route ended **1417 m** from the last point;
- `renderSnappedDirect` drew **different overlays** than `render`, so the two produced different pictures.

**Performance is unmoved, and P5 now runs in a gate.** `CPU_THROTTLE=4`, medians of 6, spreads 1.1–1.2×
(⚠ load ~4, a sibling tree building): warm-move **347 ms** against 343 on record, cold **1535** against
1450. The two edits the editor added ride the same incremental path — **insert 323 ms · delete 370 ms**,
20–23% of a cold match — and `__perfHooks.matchInsert`/`matchDelete` plus a `make test-map` assertion keep
that verdict re-checkable instead of re-derived.

⚠ **A drag cannot re-match per frame**, and this is why the queue exists: a warm match is ~350–545 ms while
a drag emits ~33 moves/second. Measured, **20 move events → 6–8 matches**, with the drawn route
byte-identical to a re-match of the settled sketch. `DESIGN.md` §1's two-tier feedback is the rule — the
**rough line is instant** (pure JS, every frame), the **matched route is lag-tolerant**.

**If you extend the editor, three rules the work paid for:**
1. `map.points` and the layer's array are **ONE array**. Mutate in place (`push`/`splice`/`length = 0`);
   re-assigning it leaves the renderer holding the old sketch (PLAN-EDIT failure path 11).
2. Anything keyed on a **screen position** breaks when the map moves under it. Key on the point's **`id`**.
3. A gesture must commit **exactly once**, and only when it really changed something — that single fact is
   what makes undo, the coalescer and the match count all come out right.


## 3. Resume here (earlier context, 2026-07-29 — §0 supersedes where they disagree)

- **Read first:** `PLAN-PERF.md` — its header table is the current state, §0 the step list, and §7i–§7o
  the matcher work. Then `CLAUDE.md` § "Read the reference before you write".
- **Repo:** ⚠ stale — `main` was `e608918` on 2026-07-29 and is **`4e693a3`** now (§0). The durable half
  still holds: no open PRs, nothing parked on a branch, so if something here looks unfinished it is
  unstarted, not stashed elsewhere.
- **Toolchain:** installed loft reports **2026.7.2** — and ⚠ **that string does not identify the binary.**
  `/usr/local/bin/loft` was reinstalled **2026-07-29 22:54** (md5-identical to `../loft`'s build on branch
  `tuxedo-diagnostics2`) and gained capabilities the previous install lacked while printing the same
  version as a week earlier. **Anchor any toolchain claim to the binary's mtime + md5, not `--version`.**
  `make test` is green on it. Routing absorbed the @PLN110 `len`/`size` flip with no source edits.
  Two capabilities present in this binary and not in the docs' assumptions:
  **`--native-android`** (signed APK cross-compile), and **threaded `--html`** — @PLN117's browser `par`,
  which `loft --html` selects when the program has a reachable `par` (`--threads` / `--no-threads`
  override; neither is listed in `--help`). The atomics std is prebuilt in
  `/usr/local/share/loft/html-mt/`, so a threaded build costs **~0.7 s**, not a cold `build-std`.
  ✅ **That sysroot IS refreshed now** — the 2026-07-31 08:10 install rewrote
  `html-mt/wasm32-unknown-unknown/` (the parent dir still reads jul 24; look one level down). The
  standing ⚠ about it being stale is discharged.

  **⚠ 2026-07-31 — the binary changed AGAIN, mid-session, and the version string did not.** This is the
  documented hazard caught live, so treat it as the worked example rather than a warning in the
  abstract:

  | | earlier that day | after 08:10 |
  |---|---|---|
  | mtime | `2026-07-30 22:42` | `2026-07-31 08:10:02` |
  | md5 | `7bafaf60…` | `36df4721…` |
  | size | 14 460 440 | 14 500 776 |
  | `--version` | 2026.7.2 | **2026.7.2** |

  A different binary, 40 KB larger, same string. **PR #30 was gated on `7bafaf60`** (its body says so —
  anchor the claim to the binary, always); `main` was then re-verified green on `36df4721` across
  `make test`, `test-native`, `test-wasm` and `test-map`. Two routing-filed issues are FIXED in it:
  **loft#699** (a `vector` param with a `= []` default panicked the parser) — original repro re-run, it
  now prints `both=6 defaulted=3` — and **loft#700** (the silent store corruption), per `../loft`
  `2ba50550` *"check the store's recorded layout before reading it whole"*. `loft targets wasm` reports
  no missing browser builtins. ⚠ The same rebuild also changed the **wasm** for unchanged sources
  (1 320 670 → 1 327 196 bytes, behaviour identical) — see §0's sidecar note.
- **Gates** — `make test`, `test-native` (now includes **`tools/tile_border_gate.sh`**), `test-wasm`,
  `test-map` (browser render + the @PLN105 bridge probes + the step-18 threading tripwire + **the whole
  rough-editor gesture suite**, driven with real `Input.dispatchMouseEvent` / keystrokes / SHIFT), and
  **`tools/match_parity.sh`**. ⚠ **CI has no chromium**, so `test-map` and the bridge gates are local-only.
  `browser/map.test.mjs` is the DOM-free tier beneath it (projection, pan/zoom, and every editor
  invariant that is pure logic) — it runs first inside `map_render_gate.sh` and needs no browser.
  ⚠ `map_render_gate.sh` also **greps** what no run can see: every pointer/click listener lives in
  `rough.mjs`, and the app reaches the kernel from exactly **two** places, both inside queued jobs.
- **Instruments** (durable, in `tools/`): `map_profile.sh` (**always `CPU_THROTTLE=4`**),
  `match_parity.sh`, `tile_border_gate.sh` + `tile_border_probe.loft` (routes across tile borders,
  order-insensitivity), `corpus_anchor.loft` (§7 quality per sketch — the gate for ROUTE-AFFECTING
  changes), `corpus_tube.loft`, `match_phase_probe.loft` (cold-match split, 3-point **and** 40-point),
  `union_probe.loft`, `nodekey_probe.loft`, `spatial_probe.loft`, `wasm_threads.mjs`,
  `match_session_probe.loft`, `deliver_probe.sh` + `expose_probe.sh`, `tile_overhang.loft`,
  `coverage_probe.loft` (bytes/km² per layer — PLAN-SCALE §1's sizing instrument), `paged_gate.sh` +
  `paged_http_gate.sh` (the working-set read path, local + HTTP Range + browser), `range_server.py`
  (a static server that really honours `Range` — `python -m http.server` does not), and
  **`ws_poke.mjs`** — speak the server's WebSocket protocol by hand, one frame in / every reply out.
  Debugging a client through the server: **[`docs/debug-websocket.md`](docs/debug-websocket.md)**.
  ⚠ **`wasm_threads.mjs` is a REGRESSION gate on our own wasm, not a capability detector** — read its
  header before treating a green run as news. It was BLIND until 2026-07-29 (it checked the memory
  *section*, and a threaded wasm *imports* its shared memory), so it passed a genuinely threaded bundle;
  it now checks the import section + the TLS exports and **self-tests three control modules on every run**.

**Nothing is blocked upstream — re-validated 2026-07-30 on the binary installed that morning.**
Performance's last dependency (browser `par`) shipped 2026-07-24 (§2's step-18 row), and coverage's
(`PLAN-SCALE`'s browser read path) shipped overnight: the working-set loaders
(`store_load_key/keys/range`) were absent from the wasm target — `loft --html` failed with an `E0599`
inside generated Rust — and [loft#678](https://github.com/loft-lang/loft/issues/678) `b64b4291` routed
them through the asyncify `fetch()` bridge. `tools/paged_http_gate.sh` now reports **`browser=pass`**,
a keyed tile costing **262 KB in 5 range requests**; it turned green on its own, which is what a
standing gate is for. ⚠ The fix is `fixed-pending-merge` on `tuxedo-diagnostics2`: it is in the
binary installed here, **not** in a fresh install from loft `main`.

**Six routing-filed issues landed within a day** — #678, #680, #681 in the morning; **#683** (an index key
is type-checked once the whole file is known), **#684** (a program argument spelling a subcommand is no
longer swallowed) and **#688** (the NRVO return buffer is freed on paths that do not deliver it — a store
leak that killed the first country-sized generation at 65,535 records) by the afternoon. All re-verified
against their original repros on the 14:35 binary. ⚠ The installed loft changed **five times** on
2026-07-30 and reported `2026.7.2` every time. Earlier note:

**Three routing-filed issues landed within a day** (all `fixed-pending-merge`, i.e. present in the
installed binary, not yet in loft `main`): [#678](https://github.com/loft-lang/loft/issues/678) paged
loaders in the browser (+ a follow-up making the SHA-verifying `store_load_url` browser-available too),
[#681](https://github.com/loft-lang/loft/issues/681) an `--html` import-validation regression that briefly
blocked rebuilding the kernel wasm, and [#680](https://github.com/loft-lang/loft/issues/680) the
per-target builtin surface — now a command: **`loft targets wasm`** answers *which builtins are missing on
the browser target* before you design against them (today: none). `loft --html --host-provided` also
exists now, for a consumer that drives the emitted wasm from its own JS host, as this app does.

⚠ **`browser/store-kernel.wasm` is committed and rebuilt BY HAND** (`node browser/build-store-kernel.mjs`).
A kernel change can pass every native gate and never reach the browser; `map_render_gate.sh` now FAILS
when the wasm predates any kernel source.

### If you are looking for the next thing to do

`PLAN-PERF` §0 is empty and `PLAN-EDIT` is done, so there is no queued step. **The next body of work is
scoped in [`PLAN-SCALE.md`](PLAN-SCALE.md)** (2026-07-30) — coverage: one 283 km² block → Western Europe
**that stays current**. Read its §6b **coverage ladder** (C0→C5: paged single block → NL → Benelux+1 → WE
roads → WE base map, each rung a live deployment, rollback = flip the index) and §8's freshness target
before picking a task. Its S0/S1 are measurements, not code, and **S1 — does loft's paged Range reader work
in a `--html` build? — gates everything else.** ⚠ The refresh loop (§7) starts at rung C1, not at the end:
it is nearly free on one block and is the only reason the 40-block version is ever trustworthy. Smaller
candidates, in the order the evidence favours:

1. **A service-worker COEP shim** — the one thing standing between the app and step 18. loft's browser
   `par` works (8 workers, verified on the installed binary), but GitHub Pages cannot send COOP/COEP, so
   the deployed page would run `distinct_workers=1`. A local COI host would let you measure the win on
   OUR workload before the deploy problem is solved (@PLN117's own bench gets ~5.2× at 8 workers on a
   CPU-heavy `par` — that is loft's number, not ours), and §6b B's determinism design is already written.
2. **The cold match's `build_graph`** (93 of 201 native) — the remaining bulk, with persistence rejected
   (§2). Anything here is making the build itself cheaper.
3. **A dense sketch is the honest case** — on 40 points the anchor SEARCH is ~75% of a cold match against
   ~35% on 3 points. Measure the case you intend to improve; `match_phase_probe.loft` runs both.

⚠ Whatever you pick: **re-measure the premise before building on it** (`CLAUDE.md` § "Measure before you
design"). Several numbers in this file are weeks old, and a doc's premise goes stale when a different
commit removes its justification.

### Where the remaining time actually is

Native cold-match split (TUBE tier, the one a cold match uses): **corridor 20 · build_graph 93 ·
match 88**. In the browser a cold match is 1450 ms and a warm one 343 ms.

- **The warm match is the interaction users perform**, and it is now 343 ms. Most of it is the anchor
  pass, whose two levers are closed (§2).
- **The cold match's remaining bulk is `build_graph`** (93 of 201 native). Persisting it is rejected
  (§7a(2)); what is left would be making the build itself cheaper, and `add_edge`'s record construction
  is already down from 14 fields to 4.
- **A dense sketch is the honest case.** `match_phase_probe` runs a 40-point sketch as well as the
  3-point one: on 40 points the SEARCH is ~75% of a cold match, where on 3 points it is ~35%. Anchoring
  is per POINT — measure the case you intend to improve.

**Traps this session paid for, so you do not have to:**
- **A probe outside a gate is a comment.** Four instrument bugs were found in one day; every one was a
  probe no gate ran, silently invalidated by a later step. All bridge probes are now in `make test-map`.
- **A profile without its spread is not a measurement.** Sibling-tree builds put this box at load average
  25 mid-session and produced a 2.0× spread that read as a regression. Check `uptime` first.
- **A corpus average is not a claim about a specific interaction.** Step 22's first gate won on corpus
  aggregate and made the app's own sketch 1.7× slower (§7h). The app's sketch is now IN the corpus.
- **Store-format changes fail SILENTLY** — an old-schema store gives no output, no error, exit 1. And the
  file size can be byte-identical after adding fields; read a field to verify, not `ls`.

- **Known-stale below:** §§4–11 predate the `lib/` package layout and the store app; treat them as
  history. (They were §§2–9 before §§1–3 were rewritten — the range was renumbered with them.)
  ⚠ Two things in §9 are already stale in a way that matters: **PR #8 is closed** (no PRs are open), and
  Track 1d's "Leaflet base map" was superseded — the app has its **own canvas renderer** (PLAN-MAP), which
  is what §§1–3 describe.

---

## 4. What works / is merged to `main`

- **Tile-block matching** — `server/server.loft` binds the block once (`store_persist_bind`) and reads
  its corridor via `tiles_corridor_ways` per request, Overpass fallback when outside coverage. Verified
  live: 811 m / 0 bridges from tiles, no network; warm edits ~40–68 ms.
- **Match-quality instrumentation** (`lib/routing_kernel`) — `match_quality()` emits the PLAN-MATCH §7
  numbers (deviation, bridged length, on-network length, per-metre suitability penalty, road-class mix),
  captured **during assembly** (`assemble_stretch`) since the stitched route isn't a clean edge-walk.
- **Browser-app compute+data core, proven headless in wasm** (`client/app_kernel.loft`, PLAN-APP Track 1
  step 1) — loads a WHOLE test-set directly (one Overpass-JSON file via `parse_ways`, no mmap store, no
  codec) and runs the **full matcher** (`parse_ways → build_graph → match_route`) byte-identically on
  interpret == native == native-wasm (472 ways → 90-pt route on the `real_stretch` fixture). This is the
  first wasm proof of the *whole* matcher — the earlier gate only covered the geodesic. Standing gate:
  `tools/app_headless_test.sh`, wired into `make test-wasm`.
- **Serverless browser shell runs in a real browser** (`browser/`, PLAN-APP Track 1a–c), built the
  **loft-native way** — `client/web_kernel.loft` → `loft --html` → the page fetches a whole test set
  and runs the full matcher in wasm over loft's own `host_input()`/`println` channel (a 4-import shim;
  **no jco, no WASI, no npm**), draws the route on an SVG, re-matches on each map click, **no server**.
  It is **fully offline-capable**: a **service worker** (`sw.js`) caches the app shell + wasm and the test
  set is cached in **IndexedDB**, so a reload with the **network entirely off** still loads and matches.
  Verified in headless Chromium (`tools/browser_app_test.sh`, via CDP): the in-browser route is
  **byte-identical to the native reference**, a synthetic click re-matches, and a fully-offline reload
  still matches from cache. *(An earlier jco-based shell was the wrong tool and was retired for this.)*
  Remaining **Track 1d**: a **Leaflet** base map + a **GitHub Pages** deploy — no loft dependency.
  - ⚠ **loft debugger `eval`/`setValue` break in any frame with a `vector` local** (`../loft` `dc06812a`):
    breakpoints verify, the `stopped` frame inspects fine, `stepOver`/`continue` work — but `eval` returns
    `null` for *everything* (even `2 + 2`) and `setValue` is rejected once the paused frame holds a
    `vector<T>` local (scalars/structs are fine). Since real code always has vector locals, eval/setValue
    are effectively unusable. Minimal repro + narrowing in `docs/loft-feedback.md` (2026-07-07); no open
    tracker issue — maintainer's call to file.
- **Plan docs** — `PLAN-MATCH` (escalation ladder + §7 numbers + §9 mode×intent), `PLAN-ROUTING`
  (get-me-there fork), `PLAN-APP` (the standalone app; §10 concrete steps; §11 data freshness). Plus the
  pre-existing `PLAN`, `PLAN-BROWSER`, `PLAN-TILES`, `DESIGN`.
- **Open-project setup** — `LICENSE` (LGPL-3.0-or-later), `LICENSE.data` (ODbL-1.0 for the blocks), SPDX
  headers on our sources, `ATTRIBUTION.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `.github/ISSUE_TEMPLATE/`.
- **CI** (`.github/workflows/ci.yml`) — builds binaries (server + wasm client) and runs `make test` on
  every PR/push. The wasm-parity *run* is non-blocking (was gated on loft#521, now fixed — re-enable
  blocking once the fix reaches loft `main`; see §9).
- **Data-refresh workflow** (`.github/workflows/data-refresh.yml`) — monthly, **dormant** until
  `tools/build-blocks.sh` exists (see §5).
- **Pipeline tools** — `tools/gen-tiles.loft` (block generator) + `tools/geojson2overpass.py`
  (converter), rescued from scratch so the data pipeline is portable.

## 5. Open PRs

**None (2026-07-31).** #30 is the most recent, merged 2026-07-31 (§0); PR #8 was closed unmerged, and
#17–#22 are merged with their branches deleted. The working agreement: push every branch as a safety
net, but open a PR only when asked or for genuinely PR-worthy work — and `main` only ever moves through
a PR with a green `build-test`.

---

## 6. External dependency states (loft) — the real gating

| issue | what | state | effect here |
|---|---|---|---|
| loft#511 | collection capture into closures | **FIXED (merged)** | unblocked the server binding the block into the event loop |
| loft#513 | store re-init (bind reads full data) | **FIXED (merged)** | **⚠ changed the on-disk store format** — `.tiles` written by pre-fix loft read *empty*; regenerate with current loft |
| loft-libs-net #517 | HTTP range/bytes/headers/size stack | **implemented on branch `tuxedo-517-http-stack`, NOT merged** | needed for browser working-set **range reads** (Benelux+, PLAN-APP Track 2) |
| **loft#521** | `--native-wasm` aborted at runtime (#518 spawned a main-stack thread wasip2 can't create) | **FIXED** — loft `db19ec43` (branch `tuxedo-add-to-project`): wasm `main` runs directly, native keeps the large-stack thread. **Confirm it reached loft `main`** before trusting a fresh main checkout. | **Unblocked**: Track 1 (browser) + Track C's "prove under wasmtime" run step now work — no pre-#518 workaround needed. |
| **loft#522 / B4** | store read in wasm: heap `store_load(path)`, HTTP `store_load_url(_trusted)`, paged `store_load_key(s)` / `store_load_range` | **SHIPPED** (in the installed loft, 2026.7.1) | **Unblocked the whole PLAN-BUILD app.** `store_load` decodes a store in wasm (verified byte-for-byte under `--native-wasm`); `store_load_url_trusted` fetches over HTTP, the fetch asyncify-bridged to JS `fetch()` in the browser (verified in-browser). No codec, no jco. |

The #521 fix has landed; once it merges to loft `main`, flip the CI wasm gate back to blocking (§9).
**loft#522 / the B4 store-in-wasm gap is now SHIPPED** — the `store_load*` family reads a store in wasm and
fetches one by URL, which is what the PLAN-BUILD store app runs on (`browser/store-app.*`). The earlier
"no codec — a store file is its own serialization" bet held: the browser reads the store directly.

---

## 7. The tile data + how to regenerate it

⚠ **2026-07-31: regeneration is MANDATORY after a `TTile` schema change, and a stale block reads
GARBAGE rather than failing** (loft#700 — see §0). The recipe also changed: `osmium tags-filter
w/highway n/barrier` and `osmium export --geometry-types=linestring,point`, because a gate across a
path is a NODE. `tools/build-blocks.sh` now invalidates its cached intermediates when that recipe
changes; `tools/split_block.loft` asserts that no barriers are lost across a split.

Current blocks — **all regenerated 2026-08-01** from a freshly fetched, md5-verified Geofabrik extract
(1 395 092 512 bytes). Two things forced a full regeneration rather than a re-clip, and both mean an
OLDER block reads as GARBAGE rather than as missing data (loft#700):

* `TRoad.flags` widened **u8 → u16** to carry the signposted-network bits (`RF_NET_*`, PLAN-RESTORE R3);
* the base map gained heath/scrub, nature reserves, amenity sites, borders, power lines and
  cemetery/reserve/site labels, none of which the 2026-07-30 blocks contain.

| block | ways / features | barriers | on a network (walk / cycle / mtb) | size |
|---|---|---|---|---|
| `browser/stores/enschede.roads.store` (ships with the app) | 49 890 | 4 048 | 4 543 / 2 832 / 671 | 4.2 MB |
| `blocks/nl-west.roads.store` | 1 388 996 | 114 329 | 121 572 / 74 726 / 5 104 | 233.4 MB |
| `blocks/nl-east.roads.store` | 1 396 480 | 119 924 | 191 046 / 108 300 / 19 096 | 263.9 MB |
| `blocks/nl.names.store` (R4 search) | 296 474 streets + 12 700 places | — | — | 36.1 MB |
| `browser/stores/enschede.names.store` | 4 502 + 85 | — | — | 0.5 MB |
| `blocks/nl-west.base.store` | 8 721 396 features / 69 003 tiles | — | — | 999.3 MB |
| `blocks/nl-east.base.store` | 8 569 099 features / 116 561 tiles | — | — | 1 058.3 MB |

Conservation, checked rather than assumed: the road split is exact (1 388 996 + 1 396 480 = 2 785 476,
the whole-country count) and so is the base split (69 003 + 116 561 = 185 564 tiles; 8 721 396 +
8 569 099 = 17 290 495 features). OSM drift over the two days since the previous build was **+0.040%**
on ways, and every category moved by a comparable fraction in the same direction — which is what a data
refresh looks like, as against a pipeline change, which moves one category and leaves the rest.

⚠ **The base halves got SMALLER while carrying MORE** — 999 + 1058 MB against 1370 MB each before,
2 057 MB against 2 740 MB. That is loft#710 (a persisted store's size is a function of insert order, not
of content) working in our favour, not data loss; the feature counts above are the check, and they rose.

⚠ **The RELEASE still holds the 2026-07-30 assets.** Everything above is local. `tools/fetch-site-blocks.sh`
verifies each download against the sha256 in the index and will correctly REFUSE the old assets, so a
Pages deploy from `main` cannot succeed until ~3.4 GB is re-uploaded under the tag `data-v2026-08-01`
(the tag `data/coverage.toml` and `browser/coverage.json` now both name).


- The block **`soverijssel.tiles`** (21 MB, southern-Overijssel, 1215 tiles) is **gitignored** (`*.tiles`)
  — it does not travel. The server matches from it if present in the launch dir, else Overpass.
- **It must be regenerated with the current loft** (loft#513 format change). Pipeline (now in `tools/`):

  ```sh
  # 1. Geofabrik extract → highways only → GeoJSON-seq (LineStrings + tags)
  osmium tags-filter <region>.osm.pbf w/highway -o roads.pbf
  osmium export roads.pbf -f geojsonseq -o roads.geojsonseq
  # 2. → Overpass-JSON shape that parse_ways/gen-tiles consume
  python3 tools/geojson2overpass.py roads.geojsonseq overpass.json
  # 3. → the tile block (native; writes an mmap store)
  loft --native-release --lib lib tools/gen-tiles.loft <region>.tiles overpass.json
  # 4. OSM snapshot date for the attribution (PLAN-APP §11)
  osmium fileinfo -e -g data.timestamp.last <region>.osm.pbf
  ```
  (`parse_ways` reads **Overpass-JSON**, not geojsonseq — step 2 is required. Verify counts: soverijssel
  = 1215 tiles / 229,117 roads.)
- **`tools/build-blocks.sh` does not exist yet** — scripting the above per-block (with the snapshot
  stamp + top index) is PLAN-APP Track C/2 work (steps F3/F4). Writing it activates the data-refresh
  workflow and Benelux/WE generation.

---

## 8. Environment to resume

- **loft** as a sibling checkout at `../loft`, built: `cargo build --release` (needs **mold** on Linux;
  `export SDKROOT=$(xcrun --show-sdk-path)` on macOS). Point the app at it via `LOFT=../loft/target/release/loft`.
  - The local `../loft` here now includes the **#521 fix** (`db19ec43`, branch `tuxedo-add-to-project`):
    `--native-wasm` runs under wasmtime, no pre-#518 workaround needed. For the wasm **build/rlib**: `rustup target add wasm32-wasip2`
    then `cargo build --release --target wasm32-wasip2 --lib --no-default-features --features random`.
- **Build/test/run:** `export SDKROOT=…` (mac); `make build`, `make test`, `make run`. CI mirrors this.
- **Browser (Track 1) needs only `node` + a `browser`** — the app is built with `loft --html` (loft's
  own browser engine), so **no jco / npm / WASI**. `node browser/build.mjs` produces `browser/web_kernel.wasm`;
  `node browser/serve.mjs` serves it. wasmtime is enough for the separate headless `--native-wasm` gate,
  and with #521 fixed it runs (verified via `make test-wasm`).

---

## 9. Next steps (from PLAN-APP §10/§11)

Do in this order; **O** and the doc/tooling are done or in-flight.

1. **Merge PR #8** (CI note) — trivial.
2. **Track C — data-access core** (headless). **⚠ Rescoped — no codec.** A store file IS its own
   byte-exact serialization (portable native↔wasm), so there is nothing to hand-decode; loading a tile is
   reading store bytes into a heap arena. The working-set data path is now **loft#522** (partial store
   load over HTTP range reads → fill a local store that behaves as if the whole store loaded), which is
   **maintainer-side loft work**. Routing side, once #522 lands: build blocks as `sorted<TTile[tkey]>`
   (range-friendly for a geographic cell window — a hash index forces near-whole-file reads), a working-set
   **resolver** (`pts+margin → tkey range`), then `store_load_range` → match. Phase 1 of #522 (plain heap
   `store_load(path)`) alone unblocks whole-block wasm loading, provable under wasmtime now (#521 fixed).
3. **F1/F2 (data freshness)** — stamp `osm_snapshot` in `gen-tiles.loft` + top index; show "data as of …"
   in the app attribution.
4. **Track 1 — browser app.** ✅ **1a–c done** — `browser/` (loft-native: `web_kernel.loft` → `loft --html`,
   `host_input`/`println` engine, no jco) fetches a whole test set and runs the full matcher in wasm,
   interactive (click → match → redraw), no server, verified byte-identical to native in headless Chromium
   (`tools/browser_app_test.sh`), with a **service worker** + **IndexedDB** so a reload with the network
   fully off still matches (verified). Remaining **Track 1d**: a **Leaflet**
   base map, deploy to Pages
   (unlisted URL). No loft dependency. The whole-file model holds until loft#522 lands the working-set
   partial load. See `browser/README.md`.
5. **Track 2 — Benelux**: `tools/build-blocks.sh` (F3) → generate blocks → top index → Release hosting
   (verify cross-origin CORS/Range) → working-set range loading. Enable the data-refresh cron (F4).
6. **Track 3 — Western Europe**: more blocks + cross-block stitching + LRU.

---

## 10. Gotchas / things that cost time (don't relearn these)

- **`store_persist_bind` (mmap write) is native-only** — but reading a store in wasm now works:
  **`store_load(r, path)`** is the heap reader for a browser / wasm target (verified byte-for-byte under
  `--native-wasm`), and **`store_load_url_trusted(r, url)`** fetches a store over HTTP and decodes it in the
  browser (the fetch asyncify-bridged to JS `fetch()`). The "no codec — a store file is its own
  serialization" bet held. (Supersedes PLAN-APP §3's fetch+decode-codec framing and the 2026-07-09
  loft-feedback "B4 gap" entry.)
- **loft#513 changed the store format** — any `.tiles` from an older loft reads *empty*; always
  regenerate after updating loft.
- **`parse_ways` eats Overpass-JSON, not geojsonseq** — hence `tools/geojson2overpass.py`.
- **loft#521** (FIXED, loft `db19ec43`): every `--native-wasm` program *used to* abort at runtime under
  any wasmtime (43 and 46) — the #518 thread-spawn, **not** a wasmtime version; a wasmtime pin did not
  help. The fix runs wasm `main` directly. If you see the abort again, you're on a loft build predating it.
- **`make test` needs** node 22 (global `WebSocket`), `fuser` (psmisc), and creates `scratch/` itself.
  `make test-wasm` needs wasmtime.
- **CI builds loft from source** (no public binary); it caches on loft's HEAD sha and builds both the
  host binary and the wasip2 rlib.
- **Scratch is ephemeral** — anything under the session scratchpad (old experiments, the netherlands
  `.pbf`, intermediate `.tiles`) is gone on a new machine. The pipeline is now in `tools/`.

## 11. Loose ends

- CI wasm-parity gate is informational; loft#521 is fixed on branch `tuxedo-add-to-project` — re-block it
  once the fix merges to loft `main`.
- `tools/build-blocks.sh` unwritten → data-refresh workflow dormant, Benelux/WE not yet generated.
- #517 not merged upstream → browser range reads pending.
- Elevation `h` in tiles is currently 0 (gen-tiles sets `h: 0`); needed for gradient/bike/climb
  (PLAN-ROUTING) — populate from terrarium at generation.
