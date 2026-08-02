<!-- Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later -->
# PLAN-LAYERS — the network you can follow, and the ground that is always there

**Status (2026-08-02): DESIGN, nothing implemented.** Written from three probes against the **live
site** (`https://jjstwerff.github.io/routing/`, index `v2026-08-02`, headless chromium 1000×700), not
from reading the code. Reported by the maintainer as *"the inner paths disappear under 15 but a lot of
them also don't"* at `#17.24/52.07561/6.42878` (Zelhem, Achterhoek).

It answers three asks with two invariants:

| ask | § | invariant |
|---|---|---|
| add the Waymarkedtrails path parameters (cycling, MTB, and the rest) | §3 | **R** |
| make them show up consistently | §4 | **R** |
| show the NL map when no other data is available on panning | §5 | **C** |

> **R (render).** A mark draws when **its own layer** says so at this zoom — never because of the class
> it rides on, and never because of which store it arrived in.
>
> **C (coverage).** Every viewport's read set contains **at least one layer whose extent covers it**;
> a finer layer draws over a coarser one, and **only over ground it actually holds**.

⚠ **They are two invariants, not one, and that is deliberate.** Both failures look identical from the
outside ("the map is missing things"), and it is tempting to write one rule over both. They are not the
same family: **R** is a property of the style table (a visibility decision), **C** is a property of the
read set (a fetch decision), and the fix for **C** cannot be expressed in a style table at all — see
§5's falsified alternative. Fusing them would produce exactly the over-unification the design protocol
warns about: one mechanism forced over two families that assert their differences at the first border.

---

## §0 — the executable list (one commit, one observable, gates green at every step)

| # | step | observable |
|---|---|---|
| 1 | **Probe harness in a gate.** `tools/network_zoom_gate.sh` + `browser/cdp_zoom_drop.mjs`: at a fixed camera, assert every signposted way in view keeps its band at z14.0, z14.6, z15.0, z16.0 | 4 asserts, **red before step 2** |
| 2 | **Collect the network before the class gate** (`map.mjs:1836` moves above `:1820`) | z14.6: **137/241 → 241/241** |
| 3 | **Clamp the class ladder to the band floor** — one place, in the flat builder, not in `render()` | z14.6 draws `path`+`foot`+`service`; screenshot beside z15.05 |
| 4 | **Delete the class ladder's dead rungs** (every debut < 14 is unreachable, §4) or record why each stays | `ROAD_STYLES` rows carry a band, not a guess |
| 5 | **`network` level + type in the sidecar** — `route_networks.py` reads `network=`/`route=` into type × level | `networks: N ways`, per-type and per-level counts, none zero |
| 6 | **Carry them in `flags`** (bits 11–14, §3) through `gen-tiles` → `emit_roads` marks → `parseStreetsFlat` | `match_parity.sh` **byte-identical** (the cost table does not read the new bits) |
| 7 | **Draw by level** — width/opacity from the level, colour from the type | the national LF route reads heavier than a local loop |
| 8 | **Generalise the overview by level** — `build_overview.loft`'s `net_classes` selects on level × `zmax` | country zoom stops being a red blanket; overview size reported |
| 9 | **The floor, resident** — read `nl-overview` once into a JS-side index, keep it, draw it under everything | retained bytes reported; z15 in Münster is no longer blank |
| 10 | **Clip the floor to the complement of held ground** | z16 shows **no** ghost lines beside real ones (§5) |
| 11 | **Retire `holdFrame`** (`map.mjs:1479`) — the floor supersedes stretched stale pixels | band-crossing gate green with it removed |
| 12 | **Fix the outside-coverage fallback** (`coverage.mjs:207`) — outside → the floor block + an honest HUD | Münster names the floor, not `nl-west` |
| 13 | **Rebuild the kernel on the new loft, re-bind the blocks, re-measure** (§6) | requests/bytes/file sizes, before and after, on **the installed binary** |

Steps 1–4 are the reported bug. 5–8 are the ask. 9–12 are the pan. 13 is independent of all of them and
makes each cheaper.

---

## §1 — what the site does today, measured

Three probes, all against the deployed site. The scratch instrument is `cdp_zoomdrop.mjs` (step 1 turns
it into a gate — *a probe outside a gate is a comment*).

**(a) The network shreds at exactly z15 → z14.** One camera, walking profile, counting ways in the
viewport by class and asking which pass their class's `minZoom`:

| zoom | in view | drawn | dropped | signposted ways keeping their band |
|---|---|---|---|---|
| z16 | 193 | 193 | — | **96 / 96** |
| z15.05 | 458 | 458 | — | **173 / 173** |
| **z14.6** | 868 | **505** | `path` 208, `foot` 60, `service` 95 | **137 / 241** |
| z14.0 | 1 437 | 885 | `path` 318, `foot` 75, `service` 159 | — |
| z13.5 | — | — | **the roads store leaves the band entirely (R=0)** | from the floor's `net_*` lines |

The screenshots say it better than the counts: at z15.05 the red walking network is a connected web; at
z14.6 it is a scatter of disconnected stubs floating in green. **That is the reported bug, exactly** —
the paths that "disappear under 15" are `path`/`foot`/`service` (`minZoom: 15`), the ones that "also
don't" are `track`/`cycle`/`pedestrian` (`minZoom: 14`).

**(b) Below z14 there are no roads at all.** The index gives `nl-east` the band `[14, 99]`, so at z13.99
the roads store is not read; the walk/cycle/MTB networks arrive instead as generalised `net_*` **lines**
from `nl-mid` (z12–14) or `nl-overview` (z0–12). Both blocks carry the full network — verified in the
files: 41 676 `net_*` line records in each, identical counts, because `build_overview.loft:259`'s
`net_classes` is not filtered by `zmax` the way `spine_class` is.

**(c) Panning out of detailed coverage gives a blank screen.** Same instrument, camera moved east:

| camera | resolved block | stores read | features drawn |
|---|---|---|---|
| z15 · 52.20 / **7.35**°E (just past the border) | `nl-west` | — | **0 — blank** |
| z15 · 51.95 / **7.62**°E (Münster) | `nl-west` | — | **0 — blank** |
| z11 · 51.95 / 7.62°E | `nl-west` | `nl-overview.base.store` | 118 areas, 98 lines |

Two separate faults in one line: **at z ≥ 14 there is no layer in band, so nothing is drawn at all**,
and the block named for the camera is `nl-west` — 300 km west of it — because `resolveCoverage`'s
outside-fallback is *"the first block that can route"* (`coverage.mjs:207`). The app cannot say "there
is no data here" because it does not know that it has none.

---

## §2 — the invariants, and what they cost to hold

**R** — *a mark draws when its own layer says so.* Today the visibility of a signposted route is decided
by the **road class it happens to ride on** (`map.mjs:1820` gates, `:1836` collects), so a national
hiking route is drawn where it runs on a `track` and dropped 40 m later where it runs on a `path`. The
route did not change; the substrate did.

**C** — *every viewport reads a layer that covers it.* Today the bands are **exclusive** on zoom
(`coverage.mjs:57`), which is right for cost and wrong for coverage: exclusivity was chosen so a
country-wide box would not ask 454 867 cell keys of a detailed block (§6i O2), and it silently also
means *"if the fine layer has no ground here, show nothing."*

**Re-assertion sites — counted, not guessed.** `browser/map.mjs` asserts a zoom gate at **ten** places:
`:1222`, `:1324` (areas), `:1376` (barriers), `:1415`, `:1428`, `:1752` (store lines), `:1820`, `:1854`
(flat roads), `:1893`, `:1907` (object roads), `:1930` (object lines). The **network's** visibility is
asserted at **two** of them (`:1836` for the roads path, `:1752` for the floor's `net_*` lines) and they
must agree for the map to be coherent across a band crossing. Omitting the rule at a site is **silent**
— a missing mark, not an error. This repo has already paid for that shape once: the area debut ladder
lived in **six** copies and the fifth consolidation left the drawing path on the old rule, so the map
was identical while every test passed (HANDOFF §0, trap 1). **So each step below states which single
site owns the rule, and the gate reads the DRAWN result, never the table.**

---

## §3 — L1: the Waymarkedtrails parameters

**What Waymarkedtrails is, and what we keep of it.** Its layers are `hiking`, `cycling`, `mtb`,
`riding`, `slopes`; within each it draws by **network level** — international / national / regional /
local (`iwn`/`nwn`/`rwn`/`lwn`, `icn`/`ncn`/`rcn`/`lcn`). The old Leaflet client showed those as
**someone else's raster tiles** (`controls.js:81`), which the router could not read. PLAN-RESTORE R3
replaced them with vector membership: `tools/route_networks.py` reads the same OSM route relations and
writes `<wayid> <mask>`, mask = 1 walk | 2 cycle | 4 MTB.

**What we drop today:** the **level** (all four collapse to one bit), `route=horse` and
`route=inline_skates` (never read), and the route's `ref`/`name`/`symbol` (the Dutch *knooppunt* numbers
a walker actually navigates by). The level is the expensive omission: it is what makes a country-zoom
network legible instead of a red blanket, and it is the parameter Waymarkedtrails draws by.

**The representation — spare bits, not a new field.**

```
routing_kernel.loft:366   flags: u16
  bits 0–7    RF_CYCLEWAY … RF_SVC_LOCAL      the way tags (8, all used)
  bits 8–10   RF_NET_WALK | CYCLE | MTB       the three network bits
  bits 11–15  FREE  ← 5 bits, the whole budget for this design
```

Proposed: `RF_NET_HORSE = 2048`, `RF_NET_SKATE = 4096`, and **two bits of level**
(`8192`/`16384`, 0 = unknown/local … 3 = international, the **maximum** over the way's memberships,
which is what Waymarkedtrails renders by). Four of five bits; one spare, left spare.

⚠ **Bits, not a field, for a specific reason.** Adding a field to a stored struct makes **older blocks
read garbage, not empty** (loft#700) — every block must then be regenerated before anything is correct.
An unused bit reads **0**, and 0 is defined here as *"level unknown"*, which is truthful for a block
built before this step. A stale block degrades to today's picture instead of to nonsense. It still has
to be regenerated to *carry* the new parameters — and when it is, **every copier must carry `flags`
through**: `split_block.loft:28` does today (`flags: r.flags`); `build_overview.loft`, `rekey_tiles`,
`reorder_tiles` and `merge_base` each need the same check, with a conservation assert (per-bit counts
in == counts out), because a silently-zeroed bit looks exactly like "there are no MTB routes here".

**The wire format already has room.** `emit_roads` sends `class|marks`, and `x` = router-refused,
`w`/`c`/`m` = the three networks. Add `h`, `s` and a level digit `0`–`3`; an old kernel emits no digit
and the parser reads "unknown", which is the same graceful degradation as the bits.

⚠ **The marks are parsed at TWO sites and they do not agree today.** `parseStreetsFlat` (`map.mjs:751`)
reads the network letters; the object path (`map.mjs:538`) reads only `x` and **discards the network
bits entirely**. That is why the store-vs-object pixel parity gate — the instrument that caught the last
mark bug — is *blind* to a network bug: neither side draws one. Step 6 makes the two parsers read the
same vocabulary, or the gate is decoration.

**What draws.** Type → colour (the existing walk-red / cycle-blue / MTB-purple, plus riding and
skating); **level → weight and debut**. The level is the layer's own generalisation knob, and it is what
makes §4's "draw everything in the band" affordable at the country zoom:

| zoom band | network levels drawn |
|---|---|
| z < 12 (overview) | international + national |
| z 12–14 (mid) | + regional |
| z ≥ 14 (regions) | + local — everything |

⚠ That ladder belongs to **`build_overview.loft`'s selection**, not to the renderer: the overview is a
*generalisation*, and dropping a local loop from the country file is what makes it small. The renderer
draws what the block contains. One rule, one site — which is invariant **R** applied to the data side.

**Not in scope:** using the level in the cost table. `way_penalty` keeps ignoring the new bits, which is
what lets step 6 assert `match_parity.sh` byte-identical. Routing on level is a separate change with its
own gate (PLAN-MATCH's ladder), and mixing it in here would make the parity gate unable to tell a
rendering bug from a routing one.

---

## §4 — L2: consistency, and why the ladder is now a glitch

Two defects, one measured symptom.

**(1) The overlay is gated by the substrate.** `_drawStreetsFlat` skips a way at `:1820` and only then
asks whether it carries a network at `:1836`. Moving the collection above the gate is a two-line change,
and step 1's gate is what proves it: **137/241 → 241/241 at z14.6**, with no other edit.

**(2) The class ladder is dead below the band and fragmenting above it.** `ROAD_STYLES` (`map.mjs:167`)
was written when detailed roads existed at every zoom. They do not: since §6i the roads store serves
`[14, 99]`. So of fourteen rungs, the ten with a debut ≤ 14 **can never exclude anything** — `motorway`
8, `residential` 13 and everything between are dead rules — and the only rungs with any effect left
are `path`/`foot`/`service` at 15 and `platform` at 16. **The entire remaining behaviour of the ladder
is to delete the path network for one zoom step**, which is the bug as reported.

The fix is invariant **R** read on the road layer: *within a band, a layer either draws what it holds or
is not in band at all.* Concretely — clamp each class's debut to the band floor of the block it came
from, **in the flat builder** (one site, where the block's band is already known), so `render()` keeps
one gate and gains no second copy of the rule.

**The ink question, honestly.** At z14.6 this adds 208 `path` + 60 `foot` + 95 `service` to the 505
already drawn — roughly 1.7× the strokes, at `roadScale` 1.0 instead of 1.4, i.e. thinner lines. That is
a *screenshot* question, not a taste one, and step 3's observable is the pair of screenshots. If it is
too dense, the lever is **§3's level parameter** (keep every signposted way, defer unsignposted
`service`) — never a second per-class ladder, because that is the defect returning under a new name.

**Left alone deliberately:** `SHUT_STYLE` (z14, a *mark on* a way that is drawn anyway) and the POI
ladder. Both decide the visibility of their own layer, which is what **R** asks for.

---

## §5 — L3: the floor

**The ask:** when panning finds no data, show the NL map. **The measurement (§1c):** at z ≥ 14 outside a
region, the app draws literally nothing and names a block 300 km away.

**The obvious fix is wrong, and this is the claim to falsify first.** "Let the overview serve every
zoom" — drop its `[0, 12]` ceiling so it joins the read set as a fallback. It cannot work as written:
the read **mode** is a property of the *set* (`store-app.mjs:147`: paged if **any** chosen block says
so), and `coverage.mjs:54` records that a `whole` block cannot share a working set with a `paged` one.
Widening the band therefore either pages a 28 MB whole-file block or flips a 774 MB region to a whole
download — the exact fault that shipped once already (`store-app.mjs:134`). **Probe P3 in §7 is there to
kill this alternative with a number rather than with this paragraph.**

**The design: the floor is resident on the JS side, not a member of the kernel's read set.**

`nl-overview.base.store` is **one whole file, 27.9 MB, 172 913 features, 774 431 coordinates** — the
file a bare visit already downloads. Read it once at boot, copy its geometry index out of wasm memory
into plain typed arrays, and **keep it for the session** as a second index the renderer draws *under*
everything. The kernel is then free to bind, page and discard whatever the camera needs, because the
floor does not live in its working set. This is the same division the app already runs on: **loft does
the ROUTE, JS does the MAP** (CLAUDE.md; PLAN-PERF steps 9–13).

⚠ **The floor must be CLIPPED, and drawing it plainly underneath is the bug.** The overview is decimated
to one pixel at `zmax=10`; at z16 that tolerance is **~64 screen px**. Painted under a detailed view it
produces ghost lines beside real ones — a wrong map that looks like a rendering artefact. So the floor
is drawn only where the fine layer holds **no ground**: the screen rectangle minus the intersection of
(the loaded view box) and (the chosen blocks' extents), as an even-odd canvas clip. Box arithmetic,
exact, no per-feature test.

Three things fall out of that clip for free:

* **The pan case (the ask).** Past the border the fine layer holds nothing, so the floor covers that part
  of the screen: the Netherlands stays drawn, Germany is honestly empty.
* **The band crossing.** While a paged view is loading, the fine layer holds nothing **yet** — so the
  floor covers the whole screen with real vectors at the right camera. That **supersedes `holdFrame`**
  (`map.mjs:1479`, `9a596fa`), which stretches the previous frame's *pixels*; step 11 deletes it and the
  band-crossing gate must stay green without it.
* **"Outside coverage" becomes sayable.** With a floor that always draws, `resolveCoverage`'s fallback
  can name the floor block and set an honest HUD instead of pointing at `nl-west` (step 12).

**Predicted cost — the number that decides it.** 774 431 coordinates as Int32 pairs = 6.2 MB, plus
~173 000 feature records at ~40 B = ~7 MB → **~13 MB retained**. ⚠ That coordinate count is from the
**19.6 MB single-country build**; the *published* overview is the four-region build (27.99 MB, which
writes a feature in a 0.10° margin twice), so the real figure is higher by an unknown factor — P4
**measures** it, it is not scaled from this. If a phone budget cannot hold it, the fallback is a
**coarser floor** (rebuild the overview at `zmax` 8 — a build argument, not a code change), re-measured.

---

## §6 — what the newly installed loft changes

⚠ **Anchored to the binary, per CLAUDE.md.** `/usr/local/bin/loft` is **2026.8.0**, md5
`ea0486770b1ed2d703f4a5187d3b1b0f`, dated **2026-08-02 12:50** — and it is **byte-identical** to
`../loft/target/release/loft`, whose log carries loft#729 (three commits), #730 and #731, landed
10:10–12:36 the same day. It is **not** the binary HANDOFF describes (md5 `13311104…`): that one moved
under us. Everything below is upstream's measurement **on our own `nl-east.roads.store`**, and every
number must be **re-measured here** before it is written into any status doc.

| upstream change | measured on our block |
|---|---|
| **#729** read a record's body in one fetch (not 4 bytes at a time) | 1 073 065 resolve calls → **832**; a wide viewport loads **0.32 s → 0.16 s**; bytes identical |
| **#729** one request per **run** of pages | 42-key viewport **89 → 56 requests**, same bytes |
| **#729** a working set is sized by what it holds, not what it grew to | 42-tile working set **4.89 MB → 2.20 MB (2.22×)** — browser memory, per viewport |
| **#730** compaction at bind, automatically | file **161.8 → 81.3 MB (1.99×)**; 42-key viewport 4.92 → 3.67 MB (69 → 52 req); **wide viewport 31.1 → 22.3 MB, 466 → 332 req** |
| **#729** page size is now a real choice | 16 KiB: **−19% bytes and −8% requests** on a 42-key viewport; the wide viewport trades 46% fewer bytes for 35% more requests. Default stays 64 KiB — *the consumer's own viewport mix decides it, and that consumer is us* |
| **#731** a collection declared **and** iterated inside an `else if` compiles on `--native` | the mode-driven generator shape (`if mode == "write" … else if mode == "load" …`) is writable again |

**What it means for this design.**

* **The floor got cheaper to hold** — a working set is 2.2× denser, so §5's resident index competes with
  less pressure, and the fine layer costs less to re-page after the pan the floor is covering.
* **The pan itself got cheaper** — a wide viewport is 332 requests instead of 466 and 22.3 MB instead of
  31.1, before anything in this plan is built.
* **`LOFT_PAGE_BYTES` is now ours to choose.** The app's mix is *many small viewports* (a pan) plus *one
  wide one* (a band crossing) — precisely the two rows that disagree in the table. It is a measurement
  step, not a knob to guess: §7 P6.
* **⚠ Two conditions, or none of it lands.** The reader fixes live in the **wasm runtime**, so
  `browser/store-kernel.wasm` must be rebuilt with this binary; the file-size half only appears when the
  blocks are **re-bound and republished**. A green gate on an old wasm proves nothing about either.
* **⚠ It does NOT change the whole-vs-paged rule.** Nothing in #729–#731 touches how a working set is
  composed, so §5's falsified alternative stays falsified and the resident floor stands on its own.

**Out of scope here, worth costing after step 13:** the blocks halving moves the ceiling that
Western-Europe publishing runs into (§6f / D2 — the site outgrows Pages before the read path breaks).
That is a re-costing, not a design change, and it belongs in PLAN-SCALE.

---

## §7 — probes, with the prediction written down first

Each is the **cheapest thing that could prove the claim false**. A probe that only confirms is not on
this list.

| # | claim | probe | prediction — and what kills the design |
|---|---|---|---|
| **P1** | the shred is the class gate, not the data | move `:1836` above `:1820`, re-run §1a | **241/241 at z14.6.** If < 241, some signposted ways have no style row at all and §4 is incomplete |
| **P2** | the class ladder is dead below 14 | count drawn classes at z14.0 against their debuts | every rung ≤ 14 is unreachable; only `path`/`foot`/`service`/`platform` fire. If a rung < 14 fires, a block serves a band the index does not declare |
| **P3** | a `whole` block cannot join a `paged` read set | force `nl-overview` into a z15 read set behind `__readMode`, count requests/bytes | it pages a 28 MB whole file **or** flips a region to a whole download. Either result kills "just widen the band"; if **neither** happens, §5 is over-built and the band fix is the right one |
| **P4** | the floor is affordable | `byteLength` of the retained arrays after boot, on the throttled profile | ~13 MB. Above ~25 MB → coarser floor (`zmax` 8), re-measure |
| **P5** | the floor must be clipped | draw it unclipped at z16, screenshot | ghost lines offset up to ~64 px. If they are invisible, the clip is unnecessary complexity — delete it |
| **P6** | the new loft's wins are real **here** | rebuild the kernel + re-bind the blocks, then `tools/map_profile.sh` with `CPU_THROTTLE=4` and `base_paged_gate.sh`; then sweep `LOFT_PAGE_BYTES` over the app's own two viewport shapes | wide viewport ≈ −30% bytes, ≈ −29% requests; file ≈ half. **⚠ medians of 6 with the spread reported, and check `uptime` first** — a sibling build on this box has produced a fake regression before |
| **P7** | the new bits change no route | `tools/match_parity.sh` after step 6 | **byte-identical**, 5 cases. Any divergence means the cost table is reading a bit it must not |
| **P8** | the network is coherent **across** the band, not just inside it | one camera, z13.5 → z14.5, diff the drawn network | the same routes, coarser. A route present on one side and absent on the other means the overview's level selection (§3) and the block's contents disagree |

---

## §8 — gates

Green before and after every step: `make test`, `test-native`, `test-wasm`, `test-map`,
`tools/match_parity.sh`, `tools/overview_gate.sh`.

New, and part of `make test-map`:

* **`tools/network_zoom_gate.sh`** (step 1) — the signposted network keeps its band at four zooms and
  across the z14 crossing. This is the gate the reported bug would have failed.
* **conservation on the sidecar** (step 5) — per-type **and per-level** counts, none zero: a category
  silently at zero is how every data loss in this pipeline has looked.
* **per-bit conservation through every copier** (step 6) — counts in == counts out.
* **the floor gate** (steps 9–12) — at z15 outside coverage the screen is **not** empty; at z16 inside
  coverage the floor contributes **zero** drawn features.

---

## §9 — what this design does not do

* **Routing on the network level.** The bits are carried and drawn, never costed (§3). Separate change,
  separate gate.
* **Knooppunt numbers.** The route `ref`/`symbol` is the natural next parameter and needs a label layer,
  not a bit — out of scope here, and the spare bit is deliberately left for it to *not* use.
* **Coverage beyond NL.** The floor is the NL overview because that is the data that exists. Nothing
  here assumes one country: the floor is "the coarsest block whose extent covers the viewport", and a
  second country is a second floor block.
* **`par` / threading, transit, the day-planner.** Untouched.
