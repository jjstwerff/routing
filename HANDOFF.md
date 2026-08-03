# HANDOFF — resume state

Single entry point for picking this up on another machine. **Plan of record:** `DESIGN.md` (north-star)
+ the `PLAN-*.md` docs; this file is the *status + how-to-resume* layer on top, and it is deliberately
short. The dated rungs it used to carry live in **`docs/handoff-archive.md`** — read those for the
account behind a rule, never for where things stand.

---

## 0. Where things stand (2026-08-03)

**https://jjstwerff.github.io/routing/ is live and current.** `main` carries PRs #46–#48, **#52**, **#53**
and **#54**, the deploy is green, and the site serves dataset **`v2026-08-03c`** — verified end to end: the four roads
blocks it serves are sha256-identical to the ones the gates ran against, and a ranged **GET** answers
`206`. No open PRs. **One branch is ahead** — see §0b.

The app opens on the whole country, routes offline over its own blocks, and draws the signposted networks
as the routes they belong to:

| | |
|---|---|
| **the map** | country overview → middle zooms → detailed regions, chosen by zoom band; a resident coarse **floor** fills ground the fine layer has not got, and says so where nothing exists |
| **the networks** | five modes (walk · cycle · MTB · horse · inline skating). Long-distance paths draw as a named line; local ones as a **train** of coloured waymark blocks, one per route |
| **the route** | click to sketch, drag/insert/delete to reshape, distance shown, **GPX** download, sketch **autosaved** every 10 s and restored on reload |
| **the data** | 4 region roads blocks 255.5 MB · overview 26.3 MB · middle zooms 281.7 MB · names 36 MB, all same-origin or on their own Pages repos; base map 2.75 GB across four data repos |
| **what the roads carry** *(new in `v2026-08-03`)* | a **height** on every one of 17 298 515 steps, and **direction** — 340 984 `oneway=yes`, 33 317 signposted bicycle contraflows. Both cost **zero bytes**: `TStep.h` and `flags` bits 8–11 already existed, so the blocks are the same size as the ones before them |
| **the site** | 639.8 MB of a 950 MB Pages budget (67%) |

**The plan of record for all of the above is `PLAN-LAYERS.md`** — the layer model, its two invariants, and
every measurement the design was changed by. Steps 1–10 and 12 are done; **11 is deferred with its reason
written down**.

### ⚠ The store schema is v2, and older blocks are unreadable

`TRoad` carries `nets: u16`, and every tile carries a `TRoute` table with sparse `TRLink`s
(`PLAN-LAYERS` §3). loft#705 gates `store_load` on the layout a store was written with, so **a v2 kernel
meeting a v1 block fails outright** — which is the honest failure, and still a broken site. Any block
older than 2026-08-02 must be regenerated, not adapted.

⚠ **`v2026-08-03` is NOT a schema change**, and that distinction is the point. Heights and `oneway=` took
a field and bits that were already in the layout, so an older block still *reads* — it simply has zeroes
there. That is why the code could land before the data, and why a gradient cost must treat `h == 0` as
*unknown* rather than sea level (`plans/50-get-me-there/` states the negative control).

**The order that follows from it, and it is not optional:** code → regenerate → publish → merge. The
Pages deploy derives its release tag from the committed index's `version` and verifies bytes + sha256 per
block, so a dataset is always staged BESIDE the live one (`…b`, then `…c`) rather than clobbering it —
that is what keeps `main` resolving to the data it was built against while the next one is uploaded.

---

## 0b. This session shipped three datasets — and left one branch mid-flight

| dataset | what it added | state |
|---|---|---|
| `v2026-08-03` | heights on every step + `oneway=` in flags 8–11 | live, PR #52 |
| `v2026-08-03b` | castle labels (635, rank 3) | live, PR #53 |
| `v2026-08-03c` | **`Area.parts`** — holes stop being filled in | **live**, PR #54 |

⚠ **`area-holes` is 3 commits ahead of `main` and NOT merged.** They are @51 scaling work, not data:
the 62-block cap fix, the paged-probe fix, and the phase-A measurements. Safe to sit; nothing depends
on them and no data references them.

### ⚠ In flight, unfinished: `tools/build-blocks-banded.sh` (untracked)

Roads built in longitude bands so memory tracks the band, not the country — the roads equivalent of
`build-base-chunked.sh`. **Its first run was one way and two cells short** (1 480 754 / 10 372 against
Belgium's 1 480 755 / 10 374) because it trimmed the region's OUTER bounds as if they were seams, eating
the cell holding the eastern bound. Fixed but **the re-run never completed** — it was killed when the
same script deleted 37 files (below). Re-run and check both numbers before trusting it.

`tools/tiling_probe.py` (untracked) is the other half and is *validated*: cell counts within **0.25%** of
three real blocks, bytes/coord constant at **~15**, NL∩BE overlap predicted 397 against the gate's 377.
Belgium in **8.4 s** where the build takes 25 min.

## 1. What is open

1. **`PLAN-LAYERS` step 11** — `holdFrame` and the resident floor are two mechanisms for one job. The
   floor is resident only after a country view, so the held frame is still the only cover for a session
   that never sees one. The resolution is to make the floor always-resident, not to delete the fallback.
2. **A kernel death reported from the live site, not reproduced.** "wasm stopped working, so I had no way
   to progress." The sketch autosave makes it *survivable* (reload and your points are back); it is not
   fixed. What would move it: the console line at the moment it stops answering, plus
   `window.__perfHooks.kernelStats()`.
3. **Western Europe** is still bounded by PUBLISHING, not by the read path (`PLAN-SCALE` D2), and the
   blocks halving moved that ceiling without a re-costing — which is now phase A of
   **[@51](plans/51-coverage-past-nl/README.md)**.
4. **The router does not COST the gradient yet.** R2 made it *possible* — `way_penalty` can see a height
   now — and spending it is **[@50](plans/50-get-me-there/README.md)** phase B. Two of that plan's three
   data prerequisites shipped on 2026-08-03, which is why it stopped being a stub.

**All three live-map findings SHIPPED** (2026-08-03) — they were `## Open work` rows rather than plans,
and each turned out to be one decision plus one change, which is the routing `plans/README.md` predicts:
street-name repeats down to **60.0%** of before (`STREET_LABEL_MIN_PX` 70 → **105 px**, a length floor
rather than a spacing one — the spacing constant provably was NOT the lever: identical counts from 420 to
1000 px), holes drawn (`Area.parts`, `v2026-08-03c`), and **635 castle names** at rank 3 (`v2026-08-03b`).
The last two shared one regeneration, as predicted.

⚠ **The 60% was measured on the DRAWN result, and the first attempt measured the wrong thing twice** —
`layerCounts.streetLabels` (the store's 3912 named features, which no label rule moves) instead of
`_stats.streetLabels` (the 82 placed), and then the wrong camera (z15 Enschede, not the reported z17.84
Diepenheim). Both are §2 rules that were already written down.

**Three plans are open** (`gh issue list -R jjstwerff/routing --label plan`): @49 nautical navigation
(active), @50 get-me-there and @51 coverage past NL (both future). `plans/README.md` is the binding.

**Closed 2026-08-03 — the dataset shipped.** `v2026-08-03` is live: the country regenerated from the
CACHED 2026-08-01 export on purpose, so every count that moved is the change under test rather than OSM
drift — and none moved (ways 2 785 476 · barriers 234 253 · networks 312 618 / 183 026 / 24 200 / 12 126 /
543, all identical). New: 17 298 515 heights from 3 876 terrarium tiles, and direction matching the
source export exactly. The four region blocks compact to the byte sizes of the ones they replace.
⚠ One measured characteristic: terrarium carries **bathymetry**, so a way over water reads the seabed —
13 steps of 17.3 M are below −20 m, deepest −69 m in the Westerschelde channel.

**Closed 2026-08-03:** `data-refresh.yml` can run again. It cut TWO halves while the manifest had named
FOUR regions since §6f F3, so `publish-release.sh` failed building the index *after* uploading gigabytes
— and it never built `nl-mid` at all. The cause was a recipe that lived only in a shell history and got
COPIED into YAML; both cuts are now scripts (`tools/cut-regions.sh`, `tools/build-derived.sh`) that the
workflow calls, verified by re-cutting the live country and reproducing all six shipped blocks.

**Closed since the last handoff:** loft#729 (`store_load_keys` over-fetch) is FIXED upstream and
inherited here — a wide viewport reads 22.3 MB in 332 requests where it read 31.1 MB in 466, and binding
a block compacts it (nl-east 161.8 → 81.3 MB). The four region roads blocks now total **255.5 MB against
478.6**, carrying MORE data. See `PLAN-PERF` § "the 2026.8.0 store fixes".

---

## 2. Rules that still bite

Each of these cost a session or a wrong dataset to learn. The full account is in
`docs/handoff-archive.md`; what follows is the rule.

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
* **A rule is not in force until the code that DRAWS asks it.** The area debut ladder lived in six
  copies; consolidating five and leaving a sixth was worse than leaving five, because the survivor looked
  authoritative. Gates assert on the drawn result, never on the table.
* **Anchor a toolchain claim to the binary's mtime + md5, never `--version`.** `/usr/local/bin/loft` has
  changed twice mid-session while printing the same string — and did it AGAIN on 2026-08-03 08:52, mid-
  session, halfway through a bug hunt: two narrowing results from the same hour contradict each other
  because they ran on different binaries. Today it is **2026.8.0, md5
  `0849e437f5003c848168674b9eff8fdc`** (was `ea0486770b…`). `tools/loft_bug_gate.sh` prints md5 + mtime
  for exactly this reason.
* **`store_persist_bind` REWRITES THE `.dschema` SIDECAR**, and a program that dies mid-bind leaves the
  schema hash changed — which loft#705 gates `store_load` on. A probe pointed at the committed Enschede
  fixture made it unloadable by the app. Anything that binds a shipped block must work on a COPY.
* **Two `--native`-only loft bugs are live** ([loft#739](https://github.com/loft-lang/loft/issues/739)):
  a keyed lookup on a bound store ABORTS, and one sized `f#read` width returns null silently. Both are
  worked around; `tools/loft_bug_gate.sh` reports when each workaround can be deleted.
* **`store_persist_bind` over an EXISTING file keeps the old image and returns `true`** — new counts, fresh
  mtime, previous map on disk. Every persisting tool refuses an existing target (`#PERSIST FAIL`). Delete
  before you regenerate.
* **A tiered base store's EXTENT is not a geographic bound** — a 256 km tile makes all four regions read
  as most of the country. Select on the ROADS extent; a block without roads is bounded by its own base box
  (`coverage.mjs`'s `selBox`).
* **Iterating a loft collection yields COPIES** (C86). A per-tile route scan written as
  `for x in t.routes` copied three text fields per candidate and left a country build inside one function
  after 12 minutes of CPU. Walk by index — `t.routes[i]` is a live view.
* **Only a GET measures a range.** GitHub Pages answers a ranged HEAD with `200` and no `content-range`,
  so a check built on HEAD reports a correct file as broken and a poll on it never terminates. A release
  download also 302s, so a status check without `-L` fails every asset.
* **A probe outside a gate is a comment**, *a profile without its spread is not a measurement*, and *a
  corpus average is not a claim about one interaction*. `PLAN-PERF` §7e/§7h are the write-ups.
* **Wait for the view to CHANGE before measuring it.** A stability window alone returns before a cold
  paged view has started (~18 s live), and then reports the previous store's numbers as this camera's.
  This was re-learned three times in one day; every CDP probe now waits on `viewSeq` moving first.

---

## 3. How to resume

```bash
make test          # offline: kernel suites + server harnesses          (~2 min)
make test-map      # the browser gates, headless Chromium               (~10 min)
tools/match_parity.sh          # the route is byte-identical, 5 cases
tools/network_gate.sh          # sidecar + block + the router's network A/B
tools/conservation_gate.sh     # 49 categories, none empty
tools/height_gate.sh           # every step has the terrain's own height, at no cost in bytes
tools/loft_bug_gate.sh         # are loft#739's two bugs still there? (says when a workaround can go)
```

* Build with the **installed `loft` on `PATH`**; the sibling `../loft` and `../loft2` trees belong to
  other agents and are read-only (`CLAUDE.md`).
* `browser/store-kernel.wasm` is committed and must be rebuilt whenever a kernel source or the toolchain
  changes: `node browser/build-store-kernel.mjs`. `map_render_gate` fails on a stale one.
* Regenerating data: **`tools/refresh-region.sh <id> <geofabrik-path> --regions`** is the whole sequence
  (roads → heights → names → base → cut → index) and is what the workflow runs. Its parts are runnable
  alone: `tools/build-blocks.sh` (one region's roads), `tools/bake-heights.sh` (R2 elevation, on a block
  that already exists), `tools/cut-regions.sh` (the four-region cut, both rules), `tools/build-derived.sh`
  (overview + middle zooms), `tools/route_networks.py` (the route sidecar). Compaction is now a pass
  inside the cut, not a thing to remember.
* Publishing: `tools/publish-release.sh <tag>` for the release, `tools/publish-pages-data.sh` for a block
  that needs a CORS host. **Both verify before the index points anywhere.**

  ⚠ **`publish-release.sh` uploads every store the MANIFEST names that exists in `blocks/` — which is
  more than the release should hold.** The four region *base* blocks resolve to their own Pages hosts, so
  putting them on the release adds 2.75 GB no index URL points at. Stage the referenced set and point
  `BLOCKS_OUT` at it; `data-v2026-08-03` was published that way, and its asset list diffs clean against
  the release before it. Worth fixing in the script.

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
