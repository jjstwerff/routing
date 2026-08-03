# HANDOFF — resume state

Single entry point for picking this up on another machine. **Plan of record:** `DESIGN.md` (north-star)
+ the `PLAN-*.md` docs; this file is the *status + how-to-resume* layer on top, and it is deliberately
short. The dated rungs it used to carry live in **`docs/handoff-archive.md`** — read those for the
account behind a rule, never for where things stand.

---

## 0. Where things stand (2026-08-03)

**https://jjstwerff.github.io/routing/ is live and current.** `main` carries PRs #46–#48, the deploy is
green, and the site serves dataset **`v2026-08-02c`**. Nothing is in flight; no open PRs; no branch holds
work that is not merged.

The app opens on the whole country, routes offline over its own blocks, and draws the signposted networks
as the routes they belong to:

| | |
|---|---|
| **the map** | country overview → middle zooms → detailed regions, chosen by zoom band; a resident coarse **floor** fills ground the fine layer has not got, and says so where nothing exists |
| **the networks** | five modes (walk · cycle · MTB · horse · inline skating). Long-distance paths draw as a named line; local ones as a **train** of coloured waymark blocks, one per route |
| **the route** | click to sketch, drag/insert/delete to reshape, distance shown, **GPX** download, sketch **autosaved** every 10 s and restored on reload |
| **the data** | 4 region roads blocks 255.5 MB · overview 26.3 MB · middle zooms 281.7 MB · names 36 MB, all same-origin or on their own Pages repos; base map 2.75 GB across four data repos |
| **the site** | 639.8 MB of a 950 MB Pages budget (67%) |

**The plan of record for all of the above is `PLAN-LAYERS.md`** — the layer model, its two invariants, and
every measurement the design was changed by. Steps 1–10 and 12 are done; **11 is deferred with its reason
written down**.

### ⚠ The store schema is v2, and older blocks are unreadable

`TRoad` carries `nets: u16`, and every tile carries a `TRoute` table with sparse `TRLink`s
(`PLAN-LAYERS` §3). loft#705 gates `store_load` on the layout a store was written with, so **a v2 kernel
meeting a v1 block fails outright** — which is the honest failure, and still a broken site. Any block
older than 2026-08-02 must be regenerated, not adapted.

**The order that follows from it, and it is not optional:** code → regenerate → publish → merge. The
Pages deploy derives its release tag from the committed index's `version` and verifies bytes + sha256 per
block, so a dataset is always staged BESIDE the live one (`…b`, then `…c`) rather than clobbering it —
that is what keeps `main` resolving to the data it was built against while the next one is uploaded.

---

## 1. What is open

1. **⚠ A DATASET IS BUILT AND NOT PUBLISHED.** `v2026-08-03` carries heights (R2) and `oneway=`, is
   committed in `browser/coverage.json`, and every gate is green — but the live site still serves
   `v2026-08-02c`, whose blocks have zeroes for both. Publishing is four roads blocks, **267.9 MB**; the
   base map, names, overview and middle zooms are byte-unchanged and stay put. One command:
   `tools/publish-release.sh data-v2026-08-03`. Until it runs, the new fields are code-only.
2. **`PLAN-LAYERS` step 11** — `holdFrame` and the resident floor are two mechanisms for one job. The
   floor is resident only after a country view, so the held frame is still the only cover for a session
   that never sees one. The resolution is to make the floor always-resident, not to delete the fallback.
3. **A kernel death reported from the live site, not reproduced.** "wasm stopped working, so I had no way
   to progress." The sketch autosave makes it *survivable* (reload and your points are back); it is not
   fixed. What would move it: the console line at the moment it stops answering, plus
   `window.__perfHooks.kernelStats()`.
4. **Western Europe** is still bounded by PUBLISHING, not by the read path (`PLAN-SCALE` D2), and the
   blocks halving moved that ceiling without a re-costing — which is now phase A of
   **[@51](plans/51-coverage-past-nl/README.md)**.
5. **The router does not COST the gradient yet.** R2 made it *possible* — `way_penalty` can see a height
   now — and spending it is **[@50](plans/50-get-me-there/README.md)** phase B. Two of that plan's three
   data prerequisites shipped on 2026-08-03, which is why it stopped being a stub.

**Three plans are open** (`gh issue list -R jjstwerff/routing --label plan`): @49 nautical navigation
(active), @50 get-me-there and @51 coverage past NL (both future). `plans/README.md` is the binding.

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
