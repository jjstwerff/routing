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
| 1 ✅ | **Probe harness in a gate.** `tools/network_zoom_gate.sh` + `browser/cdp_zoom_drop.mjs`: at a fixed camera, assert every signposted way in view keeps its band at z14.0, z14.6, z15.0, z16.0 | **was red**: `67 of 206 signposted ways in view are neither drawn nor skipped` at z14.6 and z14.0, on the shipped fixture |
| 2 ✅ | **Collect the network before the class gate** — a signposted way is projected even when its own class is not shown yet | z14.6: **139/206 → 206/206**. Re-coupling it by hand puts the gate back to `67 of 206`, so the gate is proven non-vacuous |
| 3 ✅ | **Clamp the class ladder to the band floor** — `roadDebut(cls, floor)`, one function, both draw paths; the floor is the index's own `zoom[0]` and rides with the DATA | z14.6 draws `path`/`foot`/`service` again — the network sits ON its paths instead of floating over blank ground (A/B screenshots at one settled camera) |
| 4 ✅ | **The dead rungs are KEPT, deliberately** — with the clamp they are inert, not wrong, and the ladder is the right rule for a block whose band starts lower | unit tests assert the clamp's four cases and that the ladder stays well-formed |
| 5 ✅ | **The sidecar carries ROUTES, not a mask** — `route_networks.py` emits a relation table (type, level, `ref`, name, `osmc` colour) + way→rids | **83 762 relations → 484 252 ways**, per-type and per-level counts in §3; the legacy line format is byte-preserved and an old reader is *proven* to read the new file as the old one |
| 6 ✅ *(code + fixture)* | **The block carries them** — `TRoad.nets: u16`, a per-tile `TRoute` table + sparse `TRLink`s (§3). Every copier carries them; conservation asserted | `match_parity.sh` **byte-identical**; the router A/B unchanged profile for profile; the fixture's walk/cycle/mtb counts **identical** (4543/2832/671) with horse 260 new. ⚠ **The country blocks are NOT regenerated** — see below |
| 7 | **Draw by route** — colour from `osmc`, weight from level, `ref`/name as the label | the Pieterpad reads as itself, not as generic red |
| 8 | **Generalise the overview by level, and chain by route id** — `build_overview.loft` selects on level × `zmax` and merges runs per `rid` | country zoom stops being a red blanket; an LF route is ONE polyline; overview size reported |
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

**The representation — and the trap of trying to make bits carry it.**

The obvious move is to spend the spare bits and call it done:

```
routing_kernel.loft:366   flags: u16
  bits 0–7    RF_CYCLEWAY … RF_SVC_LOCAL      the way tags (8, all used)
  bits 8–10   RF_NET_WALK | CYCLE | MTB       the three network bits
  bits 11–15  FREE  ← 5 bits, and that is the WHOLE budget
```

⚠ **Five bits is not "space for more types", and it can never hold a colour or a name.** Two facts kill
it. **(1) A colour, a `ref` and a name are properties of the ROUTE, not of the way** — the Pieterpad has
one name along all 500 km of it — so putting them on the way stores the same string thousands of times
and still cannot answer "which route is this". **(2) A way carries SEVERAL routes**: a lane in the
Achterhoek is routinely on a cycle *knooppunt* route, an LF route and a local walk at once. A per-way
summary can say *that* a way is in a walking network; it can never say *which*, and "which" is exactly
what a colour and a name are.

So the design splits by **who is asking**, because the two questions have different shapes:

| asks | question | representation |
|---|---|---|
| **the router**, per edge, in the hot loop | *"is this way in the network I am costing?"* | a **set** — one bit per type |
| **the renderer / the label / the GPX name** | *"which routes is this way on, and what are they called and coloured?"* | an **identity** — a table, and a membership list |

**(a) The set moves out of `flags` into its own field, so it can grow.**
`TRoad.nets: u16` — 16 route types, of which 5 are spoken for (walk, cycle, MTB, horse, skate) and
**eleven are free** for the ones that come next (piste, canoe, via-ferrata, whatever the data grows).
`flags` then keeps its 8 tag bits and gains back the 3 it lent, and the router's test stays one `&`.

**(b) The identity is a per-block ROUTE TABLE, and the way points into it.**

```
TRoute { rid: u16, kind: u8, level: u8, ref: text, name: text, colour: u32 }   // one per relation
TRoad  { …, nets: u16, rids: vector<u16> }                                     // usually empty, often 1
```

`colour` comes from `osmc:symbol`'s waycolour when the relation carries one (that *is* the paint on the
tree that you follow), and falls back to the type's colour. `level` (`iwn`/`nwn`/`rwn`/`lwn`, `icn`…)
lives on the **route**, where it is not a lossy summary — the per-way `nets` bits are the summary, and
the table is the truth.

**Size, and why it is affordable — MEASURED (2026-08-02, `netherlands-latest.osm.pbf`, 11 s):**

```
networks: 83 762 relations (walk 63 513, cycle 17 537, horse 2 166, mtb 486, skate 60)
          → 484 252 ways (walk 346 036, cycle 218 308, mtb 25 086, horse 12 157, skate 545)
levels:   regional 77 370 · local/unknown 5 542 · national 741 · international 109
identity: ref 81 580 (97%) · name 7 116 (8.5%) · colour 48 777 (58%) · node_network 76 596 (91%)
members:  944 967 over 484 252 ways — mean 1.95, widest 18
```

⚠ **Four of this section's assumptions were wrong, and the measurement is why they are not in the code.**

1. **"Thousands of relations" — it is 83 762**, twenty times the guess. The table is still small (a few
   MB of text against an 81 MB block), but it is not a rounding error, and a *view* that emitted the
   whole table would be emitting a country.
2. **Names are the RARE case, not the common one.** 8.5% have a name; **97% have a `ref`** and **91% are
   node-network segments**. This § was written around "the Pieterpad has one name along 500 km" — true,
   and unrepresentative. In the Netherlands the identity a walker actually reads is the **knooppunt
   number**, so `ref` is the label and `name` is the exception.
3. **Horse and skating are real**: 2 166 horse relations over 12 157 ways, and 60 skating ones. Reading
   them was worth a bit each; leaving them out would have been leaving out a mode, not a curiosity.
4. **The level ladder above is uneven to the point of being wrong.** 92% of relations are *regional* —
   because that is how Dutch node networks are tagged — so "+ regional at z12" means +77 370 routes in
   one step while the two bands below it share 850. The ladder needs a rule that is not the OSM level
   alone (length? node-network segments merged into their network? that is what §3's chain-by-`rid` in
   step 8 is for), and step 7 must not be built on the assumption that level alone thins the country view.

**The per-way cost is now a number too:** 944 967 memberships ≈ 1.9 MB of `u16` across the country, mean
**1.95 routes per way** and one way on **18**. That mean is the strongest evidence for the split: a
per-way bitmask cannot name a route when the average way carries two of them.

### What the block actually holds (step 6, measured on the fixture)

The design above says `TRoad { …, rids: vector<u16> }`. **It is not built that way, and the density is
why.** Only 484 252 of the country's 2.78M ways are on any route (17%), so a nested vector per road is
2.78M little heap records to express 945 000 memberships — and loft#730 has just finished teaching this
repo that a record costs about twice its modelled contents. So the links are **sparse and per tile**:

```
TRoute { rid, kind, level, flags, colour, rref, name }   one per relation, per TILE that touches it
TRLink { road: u16, route: u16 }                          one per membership; both are per-tile indices
TRoad  { tp, flags, nets: u16, steps }                    `nets` moved OUT of `flags` — 16 types, 11 free
```

Per TILE rather than per block because the block is read by tile: a viewport fetches cells, and a table
living elsewhere would need a read of ground the reader never asked for. The duplication that buys is
now a measured number, not a hope — on the Enschede fixture, **1 405 distinct routes become 2 654 route
records across 125 tiles (1.9×)**, with 21 104 links, for **+10.5% on the block** (4 188 888 → 4 627 448
bytes).

**Conservation, which is the whole point of a schema change:** every road class count identical, 49 890
roads, and **walk 4543 / cycle 2832 / mtb 671 exactly as the v1 block reported** — with horse 260 newly
visible and skate **0, printed rather than absent**. `match_parity.sh` is byte-identical and the router's
network A/B is unchanged profile for profile.

⚠ **`TRLink.road` is an index into ITS OWN tile's `roads`**, so a copier may carry links verbatim only
while it copies every road in order. Every copier does today, and each says so where it copies. A copier
that ever FILTERS roads must remap them — that is the one way this representation can be silently wrong.

> ### ⚠ THE PUBLISHED DATA IS NOW OLDER THAN THE CODE — read this before merging
>
> The committed fixture is regenerated and every local gate is green. **The country blocks are not**, and
> neither is what the live site serves. loft#705 gates `store_load` on the layout a store was written
> with, so a v2 kernel meeting a v1 block **fails** rather than reading garbage — the honest failure, and
> still a broken site.
>
> Order, therefore: **code (done) → regenerate the four region roads blocks + the overview and mid blocks
> → republish → merge.** Merging this to `main` before the data is republished takes the live site down.
> The regeneration is `tools/build-blocks.sh` over the cached country extract; the intermediates it needs
> (`netherlands.geojsonseq`, 1.05 GB) are already on this machine, and the sidecar recipe string was
> changed so the cached v1 sidecars invalidate themselves rather than being reused.

⚠ **This IS a schema change, and the rule that goes with it is absolute.** Adding a field to a stored
struct makes **older blocks read garbage, not empty** (loft#700) — not a degraded picture, a wrong one.
So: **regenerate every block, update every copier, assert conservation.** `split_block.loft:28` copies
`flags` today and must copy `nets` and `rids`; `build_overview`, `rekey_tiles`, `reorder_tiles` and
`merge_base` each need the same, with per-type counts in == counts out, because a silently dropped field
looks exactly like *"there are no MTB routes here"*. Nothing may read a block older than the change —
the `dschema` is what says so, and `store_load` is gated on the layout it was written with.

**The wire grows a table, not more letters.** `emit_roads` sends `class|marks` today (`x` = router
refuses it, `w`/`c`/`m` = the networks). Marks stay, as the fast path — plus `h`, `s` for the new types.
The identity travels as **one `ROUTE` table per view**, emitted once, with `class|marks#rid,rid` on the
ways: N route records instead of N×(name+colour) copies, which is the same reason the store splits them.

⚠ **A view emits the routes it TOUCHES, not the block's whole table** — that is what keeps a country-zoom
view from serialising every relation in the Netherlands, and it is the same rule the viewport filter
already lives by.

⚠ **The marks are parsed at TWO sites and they do not agree today.** `parseStreetsFlat` (`map.mjs:751`)
reads the network letters; the object path (`map.mjs:538`) reads only `x` and **discards the network
bits entirely**. That is why the store-vs-object pixel parity gate — the instrument that caught the last
mark bug — is *blind* to a network bug: neither side draws one. Step 6 makes the two parsers read the
same vocabulary, or the gate is decoration.

**What draws.** **Route colour first** (`osmc:symbol` — the paint on the tree you are actually
following), the type's colour as the fallback (walk-red / cycle-blue / MTB-purple, plus riding and
skating); **level → weight and debut**; **`ref`/`name` → the label**, which is what turns a red band into
*"LAW 9 Pieterpad"* and a knooppunt leg into its number. The level is the layer's own generalisation
knob, and it is what makes §4's "draw everything in the band" affordable at the country zoom:

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

### What landed (2026-08-02), and the two instruments that lied on the way

Steps 1–4 are in. On the shipped Enschede fixture — which carries the same class mixture as the report
(12 960 footways, 4 118 paths, 4 274 cycleways, 1 548 tracks; 4 543 ways on the walking network):

| | before | after |
|---|---|---|
| z14.6, signposted ways drawn | **139 of 206** | **206 of 206** |
| z14.0 | 139 of 206 | 206 of 206 |
| the ways they run on | `path`/`foot`/`service` absent | drawn — the band sits on its paths |

**The gate asserts an IDENTITY, not a counter.** `drawn + skipped == inView`, all three derived by the
draw loop itself. The first version counted "dropped by class" — which the fix would have driven to a
constant zero, and *a gate that asserts a constant has stopped asking*. The identity breaks if a route is
ever re-coupled to its substrate, because the ways are then neither drawn nor accounted for. Proven by
re-coupling it by hand: `67 of 206`, then green again on revert.

⚠ **Two instrument bugs, both in the A/B that was supposed to show step 3.** Neither was a bug in the map.

1. **Sampling mid-reload.** Setting the camera fires a view load; screenshotting before it settles compares
   two DATASETS while claiming to compare two rules. The numbers moved 330 → 206 → 41 between runs. Fixed
   by waiting for `viewSeq` to stop moving, and asserting it is unchanged after both frames.
2. **The block cache repainted stale tiles.** With the view settled, the two frames came out **byte-identical
   md5** — because `render()` reuses cached blocks and `roadsBandFloor` is not a data load. `invalidateBlocks()`
   between them is what makes the comparison real. (The app itself is safe: the floor only ever changes
   through `loadRoadsFlat`, which already invalidates.)

   The identical md5 is the useful part: **an A/B whose two sides agree exactly is a broken instrument until
   proven otherwise** — a real rule change cannot leave a frame bit-for-bit identical.

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

## §5b — L4: the route as an object you can read and take away

Two asks, one theme, and both are **smaller than they look because the work is already done** — which is
the finding, and the reason this § is short rather than protocol-heavy.

**The distance already exists and is already on screen — as kernel debug text.** `emit_route`
(`map_kernel.loft:312`) prints `SUMMARY ways=N route_pts=M len=X.Xm profile=P` for *every* match,
including the streamed session path, and `len` is `path_length_m` — loft's geodesic length over the
matched geometry, not a browser approximation of it. The app then does `hud.textContent = sum`
(`store-app.mjs:555`), so the user is shown the raw line. Nothing needs computing; the distance needs
**presenting**: metres → `8.2 km`, in its own element, cleared when the route is.

⚠ **Do not recompute it in JS.** A haversine over `map.route` would be a second answer to a question
loft already answers, and the two would drift the moment either changes — the shape this repo has paid
for repeatedly (six copies of one ladder). The kernel's number is the number; JS parses and formats it.

**GPX is already written — in loft, for the client that had a server.** `routing_kernel.loft:2185`
`gpx_export(points, elevs, name)` is the format of record, and `server/server.loft:329` serves it over
the websocket. The deployed app has **no server**, so the old path (`gpx.js` → `ws.requestExport`) cannot
be reached at all. The route is already in the browser (`map.route`), so the export is a **document, not
a request**: build the same GPX 1.1 document JS-side and hand it to a `Blob` download.

* **No `<ele>`.** `gpx_export` omits the element when the elevation is `ELEV_NONE`, and the serverless app
  has no elevation source — so it takes that branch for every point, which is a *shape the format already
  defines* rather than a variant of it.
* **The two writers must agree**, and the gate is a comparison, not a promise: same points in → same
  document out as `gpx_export`, modulo the elevation branch.
* **Import is not in this step.** `gpx.js`'s reader needs `clean_track`/`retrace_m` from the kernel
  (`server.loft:332`), which is a kernel command, not a DOM change. Named here so it is a decision, not an
  omission.

**Where the code goes** — the pure half in `map.mjs` (`formatDistance`, `routeDistanceM`, `routeGpx`),
unit-tested in `map.test.mjs`; the DOM half in `store-app.mjs`. The browser assert belongs in
`cdp_verify_store.mjs`, beside the match it already drives: **after a match, the bar reads a distance and
the GPX document holds one `<trkpt>` per route point.**

---

## §5c — L5: the sketch survives, because the session does not always

**Reported from the live site:** a route was drawn, the page was reloaded, and the points were gone — and
the kernel had stopped answering in that same session, so there was no way to draw them again either.
Two faults, and they compose into "no way to progress": one destroyed the work, the other removed the
means to redo it.

**What is saved is the points the USER PLACED, not the matched route.** The sketch is the work; the route
is derived from it. Restoring the sketch re-matches and gives back an editable sketch; restoring the
route would give back a line you can look at and cannot edit — and if the two ever disagreed, the derived
one would be the lie. (Being able to export a route the kernel can no longer produce is a *separate*
want; it is not this one, and conflating them is how the wrong thing gets stored.)

| | |
|---|---|
| **key** | `routing.sketch.v1` — one record, overwritten. A recovery net, not a document store |
| **cadence** | one write per **10 s**, **leading and trailing** — leading so the first point is protected the instant it exists, trailing so the last state of a burst is what lands |
| **also flushed on** | `pagehide` (reload, navigation, close) and `visibilitychange`→hidden (a phone switching away, where a tab is discarded without another event) |
| **restored** | after the first view, before `ready` — `setPoints` commits, which posts a match, and a match queued *ahead* of the first view would make the app's first act a corridor read for a route nobody is looking at yet |
| **cap** | 5 000 points (~150 kB); beyond it the save is **refused, not truncated** — half a sketch restored as if whole is worse than none |

⚠ **A reader of persisted state must treat it as hostile**, the same rule `cameraFromHash` is written
under: a corrupt, truncated, hand-edited or future-version record degrades to *no sketch*, never to a
boot at NaN. A malformed *entry* condemns the whole record, because a sketch missing its 4th point is a
**different sketch**, silently.

⚠ **This re-opens the trap the camera comment closed, and it is closed differently.** `store-app.mjs`
says the camera rides the URL rather than localStorage partly because every gate's chromium reuses a
persistent `--user-data-dir`, so saved state leaks from one run into the next — and it names the cure's
weak point: *"staying deterministic would have meant clearing storage in all seven, with the eighth
forgetting to."* A leaked sketch is not cosmetic here: it re-matches at boot, which moves the range-read
and match counters other gates assert on. So every CDP driver clears local storage before it navigates,
and **`map_render_gate` fails if one does not** — the eighth-forgetting case is closed by a check rather
than by discipline. That check is the load-bearing part of this section.

**What this does NOT do.** The kernel dying mid-session is a real fault and is *not* fixed here — this
makes it **survivable** (reload, and your points are back), not absent. Chasing it needs what the session
that hit it saw: a `kernel job "…" failed` line, a wasm trap, or a stalled range fetch.

---

## §6 — what the newly installed loft changes

⚠ **Anchored to the binary, per CLAUDE.md.** `/usr/local/bin/loft` is **2026.8.0**, md5
`ea0486770b1ed2d703f4a5187d3b1b0f`, dated **2026-08-02 12:50** — and it is **byte-identical** to
`../loft/target/release/loft`, whose log carries loft#729 (three commits), #730 and #731, landed
10:10–12:36 the same day. It is **not** the binary HANDOFF describes (md5 `13311104…`): that one moved
under us.

> **INHERITED AND RE-MEASURED HERE, 2026-08-02.** The kernel was rebuilt on this binary
> (`browser/store-kernel.wasm`, sources hash unchanged at `221ac6fbd28d…` — the toolchain is the only
> variable) and two of upstream's claims were re-run on this box, on our own data:
>
> | claim | measured here |
> |---|---|
> | run coalescing removes round-trips, byte-neutral | the app's paged roads read: **33 → 29 range reads for the same 2.0 MB** (`map_render_gate`, old wasm vs new, same store) |
> | binding a block compacts it, content unchanged | `nl-east.roads.store` **161 793 096 → 81 271 776 (1.99×)**, 5 008 tiles / 822 452 roads read back, and a full `census` of **all 23 categories is identical** (`tools/store_compact_probe.loft`) |
> | the upgrade changes no route | `match_parity.sh` **byte-identical on all 5 cases, 3 distinct routes**; the browser gate's route is unchanged (`len=12428.0m`, 199 pts) on both wasms |
>
> ⚠ **Anything that binds a block now rewrites it, smaller.** That is the fix working, not a hazard — but
> it means the next generator run over `blocks/` silently halves those files, and a *published* block
> only shrinks when it is re-bound and re-uploaded. The blocks in this tree are **not** re-bound yet.

Everything below is upstream's own measurement **on our own `nl-east.roads.store`**; the rows not marked
above still need re-measuring here before they are written into any status doc.

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
