# HANDOFF — resume state

Single entry point for picking this up on another machine. **Plan of record:** `DESIGN.md` (north-star)
+ the `PLAN-*.md` docs; this file is the *status + how-to-resume* layer on top, and it is deliberately
short. The dated rungs it used to carry live in **`docs/handoff-archive.md`** — read those for the
account behind a rule, never for where things stand.

---

## 0. Where things stand (2026-08-04, late)

**THE BENELUX IS LIVE.** `v2026-08-03d` — 10 blocks over three countries — went out overnight when
PR #55 merged `area-holes` into `main` (`1d1b199`). Nothing is staged and nothing is pending.

⚠ **THIRTEEN COMMITS SIT UNMERGED ON `browser-owns-the-browser`, and none of them touch the data.** Three
strands, in the order they were done:

1. **Browser/test-process hygiene** (`8f55a06`, `f5ab0c2`, `67bb7c8`). Every gate's browser is owned by
   its driver over a CDP **pipe**, so it cannot outlive the process that started it — no traps, no kill
   logic, no platform-specific code. `browser_leak_gate` proves it by SIGKILLing an owner and re-taking
   the profile. The loft test server got the same treatment (`exec` + a bounded `LOFT_TIMEOUT`), and
   `fuser -k` is gone from all seven scripts. **Earned:** five leaked browser trees, 50 processes,
   1.7 GB, the oldest 2 days 18 h old, on a box whose swap was full — and 24 leaked loft servers, all
   mine, from the old broken `kill`.
2. **`be-mid` moved to its own Pages repo** (`96c9e95`, merged) — site 86% → **70%**. And the 62-block
   index cap is gone AND gated at 70 blocks (`2a52ca0`) — it had been fixed in code a day earlier with
   no test.
3. **The paged read is latency-bound, and a page index fixes it** — `docs/prefetch-index-design.md`.
   **The browser reads the one coverage index now** (v3: a quadtree over every store, read by range), the
   RING plans its pages too, and both halves are gated — `browser/page-index.test.mjs` in `make test` for
   the format, `tools/prefetch_gate.sh` for the wired path. **PUBLISHED and LIVE** — `coverage.pagesx` is
   on `data-v2026-08-03d` and merged (PR #59). **1.53× to the view on a real link**, and the gate asserts
   the map as well as the clock. ⚠ The 2.29× it first shipped with was a harness artefact — §1 item 6b.

**READ `docs/hosting-cost-model.md` BEFORE ANY HOSTING DECISION.** Its headline is not about Western
Europe: ⚠ **GitHub Pages' 100 GB/month bandwidth caps the app at ~1 000 sessions a month**, and that
binds at BENELUX. R2 beats B2 from ~10k sessions ($2.68 vs $8.91); one measurement — whether a
Cloudflare cache HIT still bills a Class B op — stands between the recommendation and paying for it.

| | live on Pages |
|---|---|
| dataset | **`v2026-08-03d` · 10 blocks** |
| coverage | **Netherlands + Belgium + Luxembourg** |

Verified on the site itself rather than on the workflow's tick: the live index serves 10 blocks, and
`belgium.roads`, `overview.base`, `coverage.names` and `luxembourg.roads` each answer a **ranged GET**
with a real `206` + `content-range`, so the paged read path works from the live origin. The deploy
re-verified every block's sha256 on the way in — which is why a rollback is flipping the index, not
regenerating.

What Benelux can do, all gated: **routes across the NL/BE border byte-identically** to a single block
covering both · draws at every zoom from z0 · a height on every step · **search that crosses borders**.
@51 phases **A–D are done and E is open**; the rung's own entry condition (a seam route) is
`tools/seam_route_gate.sh`.

⚠ **Belgium ships with NO base map above z14.** 1202.5 MB against a ~1 GB Pages site needs cutting in
two and two data repos of its own. It draws from the overview below z12 and `be-mid` at z12–14, and
above that it is roads on a plain background — a state `store-app.mjs` handles as a product, not a
fallback. Luxembourg's base is 70.6 MB and ships, so it has a complete map. **Asymmetric on purpose.**

**The site is at 664.9 MB of 950 (70%), and the headroom is real again.** It was live at 814.2 MB (86%),
where `site_size_gate`'s own margin note said the next region added is what crosses it. **`be-mid`
(149.3 MB) now serves from its own Pages repo**, `jjstwerff.github.io/routing-data-be-mid`, as `nl-mid`
and the four region base maps already did — same origin as the app, a different PATH, so no CORS is in
play. Nothing about how the block is READ changed: same bytes, same sha256, still paged by range.

### ⚠ The store schema is v2, and older blocks are unreadable

`TRoad` carries `nets: u16`, and every tile carries a `TRoute` table with sparse `TRLink`s
(`PLAN-LAYERS` §3). loft#705 gates `store_load` on the layout a store was written with, so **a v2 kernel
meeting a v1 block fails outright**. Any block older than 2026-08-02 must be regenerated, not adapted.

**The order that follows, and it is not optional:** code → regenerate → publish → merge. A dataset is
always staged BESIDE the live one rather than clobbering it, which is what keeps `main` resolving to the
data it was built against.

---

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

**On `view-ring-prefetch`, 4 commits, pushed and UNMERGED.** Nothing here touches the data or the live
site; it is the app's read strategy plus the instruments that broke when the app grew background work.

> ⚠ **TWO branches are unmerged, and this file is on one of them.** `handoff-benelux-live` carries THIS
> text; `view-ring-prefetch` carries the code it describes. **Land `view-ring-prefetch` first** — §0c is
> written as though the ring is already in, so the other order leaves `main` describing code it does not
> have. Until both land, the `HANDOFF.md` on `main` still says Benelux is staged and unmerged, which has
> been false since PR #55. A session that resumes from `main` reads that first.

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

## 1. What is open

**Benelux is deployed. Nothing is half-landed — what remains is headroom and one design decision.**

1. ~~**THE SITE IS AT 86% of its 950 MB budget**~~ — **done 2026-08-04: `be-mid` moved, 86% → 70%.**
   The pattern to copy for the next one is in `data/coverage.toml`: publish with
   `tools/publish-pages-data.sh`, then give the region `base_url_base` + `base_cors` and REGENERATE the
   index. ⚠ **Rebuild `_site` before believing `site_size_gate`** — the gate is computed from the index
   plus the built site, so a stale `_site` keeps the moved block on disk and the gate reclassifies it into
   "app shell" instead of dropping it: it reported the same 814.2 MB total with the correct index.
2. **Belgium's base map above z14** — 1202.5 MB needs cutting in two and ~2 Pages data repos
   (`tools/publish-pages-data.sh`). Until then Belgium has roads on a plain background above z14. **This
   is what item 1's headroom was bought for**, and at 70% there is now room to land the halves.
3. ⚠ **The names store does not scale past this rung.** `coverage.names.store` is 63.5 MB read WHOLE on
   first search; Western Europe extrapolates to ~500 MB. It is one store because `NAMES` is resolved once
   at boot, `store_load_url_trusted` ADOPTS, and every store numbers records from 0 — a covering set is
   not available without changing all three. Same ceiling shape as the overview. **Cost it in @51 phase E**
   rather than discovering it at C4.
4. **@51 phase E — now the live question**, since A–D are done and the rung is entered. Decide C4/C5.
   `PLAN-SCALE` §8b holds the cadence half (per-region refresh keyed on MEASURED CHANGE, not density; the
   world is a funding decision). **The hosting half is now costed — `docs/hosting-cost-model.md`.** Its
   headline is not about Western Europe at all: ⚠ **GitHub Pages' 100 GB/month bandwidth caps the app at
   ~1 000 sessions/month**, which binds at BENELUX. R2 beats B2 from ~10k sessions ($2.68 vs $8.91) and
   the code to move already exists; one measurement stands between the recommendation and paying for it.
5. ⚠ **`nl_live_gate`'s wasm trap is now A/B'd TO ITS TRIGGER, and the memory hypothesis is REFUTED.**
   `RuntimeError: unreachable` in N3's `matchSpec`. **It is the SERIAL PAGED READ that arms it, and
   prefetching the pages removes it** — one variable, same box, same binary (`4e31dbe8`, loft 2026.8.0),
   same committed wasm (Chromium module `00592962`), same blocks:

   | | |
   |---|---|
   | `main` | **TRAPS** (1/1) |
   | branch, `prefetchOn = false` — the ONLY edit | **TRAPS** (3/3) |
   | branch, prefetch on | **PASSES** (4/4) |

   ⚠ **`wasmBytes` is 41.0 MB in BOTH arms immediately before the trapping call**, so *"a `memory.grow`
   that cannot be satisfied"* — which this file named as the leading hypothesis — is not what is happening;
   the arm that dies is not the bigger one. (The 531 MB in an older profile was a different session.) What
   differs is how many reads SUSPENDED wasm: **764 with none prefetched, against 64 real ones when 699 of
   763 came out of the buffer.** The trapping arm also ran one more kernel command (2 vs 1), so the arms
   are not identical in work — that is the loose end in this A/B.
   **So the app no longer trips it, and the DEFECT IS NOT FIXED**: a page the index does not name still
   falls through to a real read (58 per view), and `nl-east.base` / `nl-mideast.base` have no index at all
   — a camera over them takes the old path in full. **The next probe:** hold the work identical and vary
   only the suspend COUNT (prefetch the view but not the ring, and the reverse), then symbolise
   `wasm-function[531]` against a debug build. `browser/cdp_nl_live.mjs` prints the session state before
   the match now, which is how these numbers exist at all — every counter used to be read *after* it.
6. **`PLAN-LAYERS` step 11** — `holdFrame` vs the resident floor, two mechanisms for one job. Unchanged.
6b. **THE MAP IS SLOW BECAUSE OF ROUND TRIPS, AND THE FIX IS WIRED AND GATED — but not published.**
   A cold Amsterdam visit is **16–26 s**, and it is **764 SERIAL round trips**, not bytes: measured
   against the live host, a 64 kB range costs the same as one byte (41 ms), so `764 × 26 ms ≈ 20 s` IS
   the wait. The browser now reads ONE coverage index (v3) and prefetches the pages a viewport needs as
   one batch, and the ring plans its cells too. **All 15 stores are indexed and `coverage.pagesx` is
   PUBLISHED and live** on `data-v2026-08-03d` — 8.5 MB, of which a viewport reads 870 kB and a session
   1.7 kB before it plans anything.

   **The ring's own misses were RETENTION, not the index.** 663 of 722 were pages the session had
   already fetched and then DROPPED — the buffer drained on consume, so the ring re-read the ground the
   view had just paid for. Pages are held to a **64 MB cap** now and the oldest evicted past it; §9 called
   this ("the index makes the refetch cheap, retention makes it unnecessary"). Local, 82 Mbps/45 ms:
   misses **722 → 59**, session hit rate **49.6% → 95.9%**, view **1.89× → 2.41×**, settle
   **1.46× → 3.22×**; live on Amsterdam it took the settle from 1.40× to **1.55×**.
   ⚠ **Retention shipped once WITHOUT the "already paid for" record and was a live regression** — eviction
   makes the bag forget and the wire does not, so Amsterdam thrashed (361.8 MB for 172.2 MB of distinct
   pages, settle **0.90×**). Both records are kept: a page is bought at most once per session. Eviction is
   forced by a gate (`window.__prefetchCap`) because no camera that fits under the cap runs that path.
   **The cap was then swept and now FOLLOWS THE DEVICE** — `clamp(navigator.deviceMemory × 16 MB, 32,
   128 MB)`. Live on Amsterdam, 64 → 128 MB takes the view **1.19× → 1.71×** and the settle
   **1.48× → 2.41×** for **+55 MB of JS heap on a ~440 MB tab** (wasm alone is 202.6 MB there), which is
   why a 2 GB phone must not get the same number as a laptop. Returns flatten at ~0.9× the session's
   distinct prefetch bytes. ⚠ Two defects only eviction could show: it **ate the in-flight batch**
   (a 16 MB cap made the view 0.82×, i.e. slower than no prefetch — the filling batch is exempt now), and
   a retained page **pinned its whole coalesced fetch** because it was a `subarray` (copied on store now,
   so eviction actually frees). The gate reports the tab's real heap for exactly that reason.

   ⚠ **The first number this was shipped with — 2.29× — was measured by a harness with INFINITE
   BANDWIDTH, and the live site refused to reproduce it twice.** `docs/prefetch-index-design.md` §12 is
   the account. Two real defects were behind it: the ring **re-bought pages the view had already paid
   for** (the buffer DRAINS on consume, so "in the bag" is not "already fetched"), and the **0.16° pad
   made the query ~40× the screen**, which on dense ground fetched 434.8 MB to serve 204 MB and made the
   deployed app **0.70×, a real regression**. Fixed: dedup + a 0.02° pad, both measured against the live
   site. **Live now, Amsterdam: 1.18× to the view and 1.55× to a settled session**, 172.2 MB fetched
   (bounded to the distinct pages), 83.9% view hit rate, identical map. ⚠ Only the RATIO is comparable live — the unprefetched arm measured 11.6 to 35.0 s for
   the same camera on one afternoon. The COUNTS are stable: 2 627 pages, 172.2 MB, 81.3% view hit rate.

   ⚠ **A session is never a teleport** — `data/journeys.json` describes a walk, and a walk costs
   **1 127 MB and 16 927 requests** over 16 steps, with a return to a scale re-fetching MORE than the
   original cold entry. Retention across scale changes is unprobed and may matter more than the index.
7. **A kernel death reported from the live site, not reproduced.** The sketch autosave makes it
   survivable. What would move it: the console line at the moment it stops answering, plus
   `window.__perfHooks.kernelStats()`. ⚠ **Benelux widens the exposure** — more blocks, more first-visit
   paths — so a second report is likelier now than it was on the NL-only site.
8. ~~**loft#762** open upstream~~ — **fixed 2026-08-04**, and the cause was not the one we reported (§0c).
9. ~~**loft#757** open upstream~~ — **closed 2026-08-03 as answered, and our reading was wrong** (§2).
   Nothing here is blocked on it, and nothing changes in the tree: every tool already binds a bare local,
   which is what the compiler now recommends in so many words.

## 2. Rules that still bite

Each of these cost a session or a wrong dataset to learn. The full account is in
`docs/handoff-archive.md`; what follows is the rule.

* **A STORE'S FILE SIZE IS ITS CAPACITY, NOT ITS CONTENT** ([loft#752](https://github.com/loft-lang/loft/issues/752)).
  Capacity climbs a ladder whose every rung is **7/3** of the last: 250 000, 300 000 and 400 000 roads all
  persist to *exactly* 91 419 400 bytes. So **two `store_persist_bind` outputs may never be compared by
  `stat`** — under 133% any difference may be one rung, and any equality may hide a doubling. Call
  `store_reclaim` first, or it is not a measurement. This cost a finding that was filed upstream, read as
  "feeding a generator its keys in order is worse on every axis", and was one commit from deleting a
  sorting stage. `bind_order_probe` reclaims before the gate reads the file.
* **A TRIM IS ONLY VALID AS A SET.** The four NL blocks gave 200 cells to Belgium; publishing them while
  Belgium stayed staged would have left those cells owned by NOBODY — a hole inside the Netherlands, at
  the border, exactly where a cross-border route goes. Either the whole set ships or none of it does.
* **CONSERVATION IS A PROPERTY OF THE INDEX, NOT OF ONE COUNTRY'S CUT** — and those stopped being the
  same thing when coverage crossed a border. C2b compared the NL regions against `netherlands.roads.store`
  and failed on a dataset that conserves perfectly: a cell that leaves the Netherlands has not vanished,
  it has MOVED. Every roads block is a part now; MISSING and SHORT stay hard failures, OVER is the trim's
  fingerprint.
* **A FRESHLY WRITTEN STORE IS ~2× ITS BOUND SIZE.** `trim_cells`, `build_overview` and anything else that
  writes rather than adopts carries the growth slack binding sheds (loft#730) — `nl-west` 108.6 MB against
  56.2 MB. **Compact before publishing** (`store_compact_probe`), or the site's roads double.
* **A GATE POINTED AT A STAGING DIRECTORY GOES GREEN WHEN THE STAGING ENDS.** `seam_route_gate` read
  `blocks/trim`, and the moment the trimmed set BECAME the real one it SKIPped — passing, having tested
  nothing. A gate must follow what ships, not where it was built.

* **A recipe that lives in a shell history is not a pipeline.** F3's four-region cut was performed by
  hand twice and written down nowhere a machine reads, so `data-refresh.yml` carried a COPY of an older
  two-halves recipe and the two drifted until the workflow could not run at all — failing *after* the
  upload. Both cuts are scripts now. The general form: if a step exists only in someone's terminal, the
  thing that duplicates it will diverge silently.
* **NEVER `rm -f "$var"*` — and set `-u`.** `build-blocks-banded.sh` deleted **37 tracked files from the
  repo root**: after a fix, `t1w`/`t1e` were only assigned on one branch, so band 0 left them unset and
  `rm -f "$t1w"*` became `rm -f *`. Recovered only because all 37 were tracked and `rm -f` without `-r`
  cannot reach subdirectories — luck twice over. Delete NAMED paths; `set -u` turns the unset case into
  an error instead of a glob.
* **`ps | grep <pattern>` matches its own grep.** Cost 12 minutes on a wait loop that could never end,
  after two `pgrep -f` false positives reported dead processes as alive. Use `grep "[p]attern"`.
  ⚠ **And the bracket trick is not enough.** It hides `grep`'s own process, not the **wrapper shell whose
  command line contains the pattern** — `bash -c '… pgrep -f "[l]oft_bug_gate" …'` matches ITSELF and
  reports the gate as running when nothing is (hit again 2026-08-03, while waiting to edit that very
  script). Confirm a hit with `pgrep -af` and look at what matched before believing it.
* **A GATE THAT DOES NOT REBUILD `_site` TESTS THE PREVIOUS ARTIFACT.** `nl_live_gate` (and most others)
  serve `_site`, which only `build-site.mjs` refreshes — so swapping `browser/store-kernel.wasm` and
  re-running a gate changes NOTHING. This invalidated three consecutive experiments that concluded "the
  toolchain is ruled out", and the conclusion happened to survive re-testing, which is worse than if it
  had not: a wrong method that gets the right answer teaches nothing. **The tell was in the output all
  along** — Chromium prints the module id (`wasm://wasm/005944be`), and three supposedly different
  binaries all reported the SAME one. **Rebuild `_site` and check the id CHANGED, or you did not swap it.**
* **THE WASM IS NOT BYTE-REPRODUCIBLE, so never compare two of them by bytes.** Two builds from the same
  binary, same sources and same size differ by exactly two bytes: `loft --html` bakes its build temp
  directory — a PID-derived path — into the output (`/home/…/.cache/tmp/loft_html_3209249/prog.rs`).
  `map_render_gate` hashes the SOURCES for staleness, which is why that check works and a byte comparison
  never could. Also: every rebuild churns 1.4 MB in git for two bytes, and the artifact carries the
  builder's home directory into a PUBLIC repo.
* **"THE COMMAND RETURNED" STOPPED MEANING "NOTHING IS IN FLIGHT",** the moment the app grew work that
  outlives the view that scheduled it (the ring prefetch). Three gates were sampling a moving app, and each
  reported a DIFFERENT plausible defect: `base_paged` saw the `expose` bracket balanced and called the pin
  missing (it was mid-command — loft releases at the start of a call and re-takes at the end);
  `cors_host` saw `ranges asked 210, DELIVERED 209` and called it a host refusing reads; `map_profile`
  counted a store fetch that had not finished. All three settle on `__perfHooks.settled()` first now, and
  each FAILS rather than sampling anyway if it times out. **A counter is a claim about a session that has
  STOPPED.**
* ✅ ~~**THE WASM IS PINNED**~~ — [loft#784](https://github.com/loft-lang/loft/issues/784) **is FIXED**
  (`c148e282`, in the binary installed 2026-08-06 10:04, md5 `22dfa069`). The batched `fetch_many` used
  `std::thread::spawn` with no wasm gate, so the browser — which has no threads — stalled in its FIRST
  paged view: `hud="loading map…"` for ever, no error, no trap, three ranges served and then silence.
  It is `#[cfg(target_family = "wasm")]`-gated now and the wasm rebuilds cleanly. ⚠ **But the browser gets
  NO batching from it** — loft says so itself: *"on wasm the ranges go one at a time"*, because the bytes
  arrive through the synchronous `loft_host_http_*` bridge and making that concurrent would change the
  host contract. **So the page index stays load-bearing for the app**; loft#782's win is native-only.
* ⚠ **AND THE SAME WORK COSTS A VIEWPORT 3-4x THE BYTES** —
  [loft#785](https://github.com/loft-lang/loft/issues/785), filed. On `nl-midwest.base` (812 MB), one z14
  viewport's 162 cells: **410 requests / 26.9 MB → 1 074 / 81.4 MB**, both backends, A/B'd against a
  binary that predates the change. It is SIZE- and SCATTER-dependent, which is why it hides: the small
  synthetic stores got 4-7x BETTER (21 requests → 3) on the same binaries. A large file plus a scattered
  key set inverts it — and that is exactly a map viewport. `tools/loft_repro/` reproduces it in 138 MB.
* **A LISTEN BACKLOG OF 5 IS A ~1 SECOND STALL, ONCE READS GO CONCURRENT.** `tools/range_server.py` used
  `socketserver`'s default `request_queue_size`, so the moment loft started issuing a store's ranges
  together, the kernel dropped SYNs and each one cost a TCP retransmit: **1 066 / 1 285 / 1 075 ms against
  27-40 ms** with a backlog of 128, bimodally, on identical work. Every range-serving gate in this repo
  would have measured that stall and charged it to the app. It is 128 now.
* **AN EMULATOR THAT MODELS ONE COST AND NOT THE OTHER DOES NOT MEASURE A TRADE-OFF — IT PICKS A WINNER.**
  `prefetch_gate` injected the round trip and nothing else, because round trips are what prefetching
  removes. A localhost server has no throughput ceiling, so the cost prefetching ADDS — bytes — was free
  in the harness, and **no result it could produce would ever have argued against prefetching more**. It
  scored 2.29×; the live site scored 0.94× and did not settle. What the harness could not see:
  **9 811 pages fetched to serve 1 331**, because the buffer DRAINS on consume and the ring therefore
  re-bought the ground the view had just paid for. Deduped, 1 156 pages and 75.8 MB instead of 643 MB; the
  honest ratio on the real link (82 Mbps, 45 ms — re-measured, unchanged since the design) is **1.31×
  live**, and getting there took a smaller pad as well as the dedup.
  ⚠ **The instrument now emulates throughput as well as latency, and the gate asserts the number that was
  missing**: not the hit rate (*"of the READS, how many were served"* — an over-fetch scores perfectly on
  it) but its inverse, **of the pages FETCHED, how many were read**, floor 60%. When a change trades one resource for another, a harness that is generous with one of them is
  not a slower version of reality; it is a different question. Same family as the ranged HEAD and the
  missing `MemorySwapMax=0`.
* **AN OPTIMISATION THAT CAN ONLY COST TIME WILL FAIL SILENTLY, SO GATE IT ON ITS OUTPUT.** The page
  index degrades by design — a page number is a fetch HINT, and a wrong one costs bytes, never a wrong
  map. That is the property that makes it safe to publish, and it is exactly why a broken one is
  invisible: `build_coverage_index.py` declared a 40-byte header beside a 36-byte `struct.pack`, so every
  offset in the file pointed 4 bytes past its own data, and **nothing failed** — no error, no wrong
  pixel, just the old slow read path wearing the new one's name. Two more of the same shape sat beside
  it: the covering set is comma-separated and the prefetch split it on a SPACE (so every multi-block
  viewport planned nothing), and a `whole` store was asked for pages it has none of (3.6 MB of index read
  at z8 to plan a single-request download). ⚠ **The general form: when the failure mode is "no benefit",
  the absence of errors is not evidence.** The gate has to read the OUTPUT back — `page-index.test.mjs`
  builds a fixture, runs the real builder and insists on the pages that went in (it fails 9 checks against
  the 4-byte regression), and `prefetch_gate.sh` requires the buffer to have actually ANSWERED. Same
  family as the paged spot check that passed while fetching nothing.
* **A rule is not in force until the code that DRAWS asks it.** The area debut ladder lived in six
  copies; consolidating five and leaving a sixth was worse than leaving five, because the survivor looked
  authoritative. Gates assert on the drawn result, never on the table.
* **Anchor a toolchain claim to the binary's mtime + md5, never `--version`.** `/usr/local/bin/loft` has
  changed twice mid-session while printing the same string — and did it AGAIN on 2026-08-03 08:52, mid-
  session, halfway through a bug hunt: two narrowing results from the same hour contradict each other
  because they ran on different binaries. It moved a THIRD time the same day at 19:06. Today it is
  **2026.8.0, md5 `4e31dbe81cdfe009178098ef96f43b09`** — installed 2026-08-04 **08:40**, the **SIXTH**
  distinct binary behind one version string (`2568302e…` 06:26, `601806ef…` 23:29, `276cf8f9…` 19:06,
  `0849e437f5…`, `ea0486770b…`), and one of them landed *while the four suites were being run for the PR*. That install was **coherent** — binary,
  `libloft.rlib`, all 267 `deps/` rlibs and both wasm targets replaced within the same second — which is the
  safe case; a half-swap is what breaks `--native`. It is also byte-identical to `../loft/target/release/loft`,
  so the sibling tree's dev build is what got installed. `tools/loft_bug_gate.sh` and `tools/bind_order_gate.sh`
  both print md5 + mtime for exactly this reason, and a finding without one is not re-runnable.
  ⚠ **A suite that STRADDLES an install has measured nothing.** That is what happened here — the four
  suites were re-run end to end on `601806ef` before the PR, and the straddled results were thrown away.
  A green tick against an unknown binary is not evidence.
* **`--native` IS THE DEFAULT, so a no-flag failure says NOTHING about the interpreter** — and this cost a
  wrong claim posted on a public issue before it was caught. Probing loft#762, `loft x.loft` failed with
  rustc errors, which was reported upstream as "not gated behind `--native`; the program cannot run at
  all". `loft --help` says *native is default*: the no-flag run WAS the native path, and `--interpret`
  runs the same file fine. **To claim a backend, name it** — `--interpret` and `--native` explicitly, never
  the bare invocation. Same family as the ranged-HEAD and the swap-cap traps: the instrument answered the
  question next to the one being asked.
* **`store_persist_bind` REWRITES THE `.dschema` SIDECAR**, and a program that dies mid-bind leaves the
  schema hash changed — which loft#705 gates `store_load` on. A probe pointed at the committed Enschede
  fixture made it unloadable by the app. Anything that binds a shipped block must work on a COPY.
* **BIND A BARE LOCAL, NEVER A STRUCT FIELD** ([loft#757](https://github.com/loft-lang/loft/issues/757),
  filed 2026-08-03 — **and our reading of it was REFUTED the same day; the rule survives, the reason
  changes**). We reported that the sidecar records the CALLER'S root shape. It does not: `store_persist_bind`
  binds **the whole store the collection lives in**, and a keyed *field* shares its container's store while a
  keyed *local* owns one. So `store_persist_bind(w.recs, …)` through a `struct Wrap { recs: …, other: … }`
  genuinely writes a `Wrap`-rooted file — **with the sibling collection `other` inside it, which the caller
  never mentioned**. The sidecar naming `Wrap` is therefore honest, and `store_load` into a bare
  `hash<TTile[tkey]>` returning `false` is an **honest refusal, not corruption**. Had it done what we asked,
  the load would have SUCCEEDED and read the `Wrap` record's bytes as a hash root — silent corruption in
  place of a clean failure. Upstream fixed the two things that were actually wrong: loft's own doc claimed
  each keyed local *or field* is its own dedicated store (false for a field), and nothing said so at the
  call — **the compiler now emits `advice` on a field bind**, on both backends (verified here on md5
  `601806ef`). Making a keyed field its own store is an allocation-model change and was deliberately not
  forced. Every tool that binds a bare `hash<TTile[tkey]>` still fails to load a field-bound block, and that
  is all of them.
  `gen_heights` did this and left Belgium and Luxembourg readable only by itself. **The records are never
  damaged — only the sidecar** — so `tools/reseat_schema.loft` repairs it without regenerating anything
  (10 128 191 heights recovered). ⚠ And the tool that causes it can still read its own output perfectly,
  which is why it survived a green gate all session: `height_gate`'s verifier used the same wrapper, so
  two wrongs cancelled. Reproduces on the interpreter too — `tools/loft_bug_gate.sh` watches it.
* **A READ THAT RETURNS NOTHING IS A BROKEN READER, NOT A CLEAN RESULT.** Fixing the above made
  `height_gate`'s verify read ZERO steps, and it still printed "no step left at 0" and "round-trips:
  999999..-999999m" in green — every assertion was over an empty set. Any gate whose checks are a loop
  over what it read back needs a non-vacuity assertion FIRST. Same family as the paged spot check that
  passed while fetching nothing, and the border route that "passed" while drawing 0 cells from one side.
* ✅ **[loft#739](https://github.com/loft-lang/loft/issues/739) is FIXED and both workarounds are GONE**
  (2026-08-03). `grid_h` reads one `i16` again instead of recombining two `u8`s, and nothing forbids a
  keyed lookup on a bound store. ⚠ **`tools/loft_bug_gate.sh` therefore FAILS now** where it used to
  report and exit 0 — the tree no longer routes around either bug, so their return is a regression that
  breaks the height pipeline rather than a status line. `height_gate` is what breaks next.
* **A CAP WITHOUT `MemorySwapMax=0` MEASURES SWAP, NOT EVICTION.** Testing whether a bound store's pages
  are reclaimable under `systemd-run -p MemoryMax=96M` had BOTH bind orders "completing" — this box has
  8 GB of swap and the unbound heap simply paged out. Adding `-p MemorySwapMax=0` separated them
  immediately: bind-first completes, bind-last is OOM-killed. Same family as the ranged-HEAD trap — the
  instrument answered a question next to the one being asked.
* **`store_persist_bind` over an EXISTING file keeps the old image and returns `true`** — new counts, fresh
  mtime, previous map on disk. Every persisting tool refuses an existing target (`#PERSIST FAIL`). Delete
  before you regenerate.
* **A tiered base store's EXTENT is not a geographic bound** — a 256 km tile makes all four regions read
  as most of the country. Select on the ROADS extent; a block without roads is bounded by its own base box
  (`coverage.mjs`'s `selBox`).
* **Iterating a loft collection yields COPIES** (C86). A per-tile route scan written as
  `for x in t.routes` copied three text fields per candidate and left a country build inside one function
  after 12 minutes of CPU. Walk by index — `t.routes[i]` is a live view.
* **`ACAO: *` is not enough for a ranged cross-origin read — `Content-Range` must be EXPOSED.** It is not
  a CORS-safelisted response header, so without `access-control-expose-headers` a cross-origin reader gets
  `null` for the store size and draws nothing, with **no console error and no failed request**. GitHub
  Pages does not send it; the four base-data repos work only because they share the app's origin
  (different paths, one host). This cost a day looking for an app bug — the block, the schema sidecar and
  the bytes were all identical, and `--disable-web-security` drew the same 252 450 features.
* **Only a GET measures a range.** GitHub Pages answers a ranged HEAD with `200` and no `content-range`,
  so a check built on HEAD reports a correct file as broken and a poll on it never terminates. A release
  download also 302s, so a status check without `-L` fails every asset.
* **`storeLoads` COUNTED SIDECARS, so the session invariant reported a re-decode that never happened.**
  `map_profile`'s `❌ the session is re-decoding` fired on every profile — baseline included — because a
  PAGED block's body never comes through `loft_host_http_get` at all; it goes through the Range bridge, and
  what the counter saw was the ~1.3 kB `.dschema` riding along with each command. `sl <= 2` was written
  when stores were read whole. Split apart, the truth is `store fetches: 0 ✅` and `15 sidecars`. Two
  instruments came out of it: `wholeLoads` (by store — five loads is fine if it is five stores once each
  and a defect if it is one store five times) and `sidecarLoads`. **The sidecar is cached now** (15 → 2),
  which is fewer than the code it started from.
* **A number is not a measurement until you know what it is ATTRIBUTED to.** The NL live gate's
  roads-block budget was a session total; the moment the base map joined that origin it failed on
  base-map bytes and accused the roads path of fetching 107 MB it never asked for. `store-kernel`'s
  stats are per-store now. Same family as the `view`-vs-`match` attribution error in `CLAUDE.md`.
* **A probe outside a gate is a comment**, *a profile without its spread is not a measurement*, and *a
  corpus average is not a claim about one interaction*. `PLAN-PERF` §7e/§7h are the write-ups.
* **Wait for the view to CHANGE before measuring it.** A stability window alone returns before a cold
  paged view has started (~18 s live), and then reports the previous store's numbers as this camera's.
  This was re-learned three times in one day; every CDP probe now waits on `viewSeq` moving first.

---

## 3. How to resume

**All four suites, in this order** — all green on this box 2026-08-04, on loft 2026.8.0 md5
`601806ef` (re-run end to end after the binary moved mid-run; §2):

```bash
make test          # offline: kernel suites + server harnesses            (~15 s)
make test-native   # the DATA gates, native backend — the slow, thorough one  (~5 min)
make test-wasm     # wasip2 parity: geodesic + a byte-identical full match  (~15 s)
make test-map      # the browser gates, headless Chromium                 (~4 min)
```

`test-native` already runs the gates below, so reach for one individually only to iterate on it:

```bash
tools/match_parity.sh          # the route is byte-identical, 5 cases
tools/network_gate.sh          # sidecar + block + the router's network A/B (the slowest, 9 profiles)
tools/conservation_gate.sh     # 49 categories, none empty
tools/block_overlap_gate.sh    # C2 no cell held twice · C2b every source cell is still held SOMEWHERE
tools/height_gate.sh           # every step has the terrain's own height, at no cost in bytes
tools/loft_bug_gate.sh         # the three upstream bugs — FAILS on #739 returning, reports #757
tools/bind_order_gate.sh       # which bind order bounds a generator, and is its memory reclaimable
```

Two that are NOT in a suite, because each needs generated data a fresh clone does not have:

```bash
tools/seam_route_gate.sh       # @51 D — a route across the NL/BE border is the one-block route
tools/trim-borders.sh          # re-derive the disjoint Benelux roads set (~10 min)
tools/prefetch_gate.sh         # the page index, wired: the app plans its own viewport, ~2x, same map
```

`prefetch_gate.sh` SKIPs without `_site/coverage.pagesx` rather than passing — with no index both arms of
its A/B agree and the experiment did not happen. Build one with `tools/finish_page_indexes.sh --stage`.
The FORMAT half needs no data at all and runs in `make test` (`browser/page-index.test.mjs`).

* Build with the **installed `loft` on `PATH`**; the sibling `../loft` and `../loft2` trees belong to
  other agents and are read-only (`CLAUDE.md`).
* `browser/store-kernel.wasm` is committed and must be rebuilt whenever a kernel source or the toolchain
  changes: `node browser/build-store-kernel.mjs`. `map_render_gate` fails on a stale one — it hashes the
  SOURCES, which is the only check that can work (§2: the build is not byte-reproducible). ⚠ **A gate
  serves `_site`, so a rebuilt wasm reaches nothing until `node browser/build-site.mjs` runs** (§2).
* Regenerating data: **`tools/refresh-region.sh <id> <geofabrik-path> --regions`** is the whole sequence
  (roads → heights → names → base → cut → index) and is what the workflow runs. Its parts are runnable
  alone: `tools/build-blocks.sh` (one region's roads), `tools/bake-heights.sh` (R2 elevation, on a block
  that already exists), `tools/cut-regions.sh` (the four-region cut, both rules), `tools/build-derived.sh`
  (overview + middle zooms), `tools/route_networks.py` (the route sidecar). Compaction is now a pass
  inside the cut, not a thing to remember.
* **Regenerating the Benelux roads set** is `tools/trim-borders.sh` — it reads the manifest, assigns every
  shared cell to whichever block HOLDS more of it (ties to the live side), and proves the result disjoint.
  ⚠ Its output is uncompacted: run `tools/store_compact_probe.loft` over each block before publishing, or
  the site's roads double (§2).
* Publishing: `tools/publish-release.sh <tag>` for the release, `tools/publish-pages-data.sh` for a block
  that needs a CORS host. **Both verify before the index points anywhere.**

  ⚠ **`publish-release.sh` uploads every store the MANIFEST names that exists in `blocks/` — which is
  more than the release should hold.** The four region *base* blocks resolve to their own Pages hosts, so
  putting them on the release adds 2.75 GB no index URL points at. Stage the referenced set and point
  `BLOCKS_OUT` at it; `data-v2026-08-03d` was published that way — **784 MB instead of 3.91 GB**, by
  staging exactly the blocks the INDEX names with a RELATIVE url (those are the ones `fetch-site-blocks.sh`
  pulls). Worth fixing in the script.

* **The switch is the MERGE, not the publish.** Publishing stages a dataset beside the live one; the site
  moves when the committed index reaches `main`, because the deploy job resolves the tag from it and
  re-verifies every block's sha256 on the way in. Rolling back is flipping the index, not regenerating.

---

## 4. Where the docs are

| doc | what it owns |
|---|---|
| **`plans/`** | **new multi-phase work — one directory per tracker issue, the way `../loft`, `../crawler` and `../moros` do it.** `plans/README.md` is the binding. The overview is DERIVED, not curated: `gh issue list -R jjstwerff/routing --label plan --state all`. ⚠ The 16 root-level `PLAN-*.md` predate this and stay where they are — they are reference docs with step ladders inside them, and they migrate opportunistically or not at all |
| `DESIGN.md` | the north star — what the product is |
| `PLAN-LAYERS.md` | **current work**: the layer model, the signposted networks, the coverage floor |
| `PLAN-SCALE.md` | blocks, bands, regions, publishing — how the data is cut and hosted |
| `PLAN-PERF.md` | what the app costs and why, including the loft store fixes |
| `PLAN-EDIT.md` | the sketch editor, and the route as an object (distance, GPX, autosave) |
| `PLAN-MATCH.md` | the matcher's ladder (the get-me-there fork moved to `plans/50-get-me-there/`) |
| `PLAN-BUILD.md` / `PLAN-APP.md` / `PLAN-MAP.md` / `PLAN-BROWSER.md` | the standalone app and its renderer |
| `PLAN-RESTORE.md` / `PLAN-TILES.md` / `PLAN-BASEMAP.md` | features restored from the old client, and the data they need |
| `docs/ARCHITECTURE.md` | which file does what |
| `docs/loft-feedback.md` | findings for loft's formal definition — the consumer's half of that work |
| `docs/handoff-archive.md` | the dated rungs this file used to carry |
