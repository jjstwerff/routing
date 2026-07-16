<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# PLAN-PERF — making the standalone app fully performant

**Status:** design. Nothing here is implemented. **Plan of record for app performance.** It does not
supersede `PLAN-MATCH` (the matcher's own ladder) — it measures it, ranks it against the other costs,
and phases the app's work around the numbers.

**The rule this doc follows:** every phase is justified by a measurement from `tools/map_profile.sh`,
and every phase names the probe that could prove it wrong. A performance design not attributed to a
measurement is a guess with a table.

---

## 0. The measured baseline

`tools/map_profile.sh` — headless Chromium, `_site` over HTTP, enschede stores (20 MB layout + 3.5 MB
roads), viewport at zoom 16, medians. The decode probes use a degenerate argument (empty bbox / two
identical points) so the command's own work is ≈0 and what remains is the store load.

**The phone column is the one that matters.** `CPU_THROTTLE=4 tools/map_profile.sh` applies CDP CPU
throttling ≈ a mid-range phone — the device this app is *for*.

| phase | `view` desktop | **`view` phone (4×)** | `match` desktop | **`match` phone (4×)** |
|---|---|---|---|---|
| store load | 90 (31%) | **355** | 5 (<1%) | **14** |
| kernel serialize / compute | 124 (43%) | **544** | ~1035 (99%) | **4370** |
| JS text parse | 37 (13%) | **157** | 0 | 2 |
| canvas render | 22 (8%) | **76** | 28 | 95 |
| **total** | **287 ms** | **1121 ms** | **~1040 ms** | **4481 ms** |
| text emitted | 4.2 MB / 29k lines | same | 4 KB | same |

Store load, split per command (the structural fact §1 turns on):

| store load (per kernel call) | desktop | phone (4×) | loaded by |
|---|---|---|---|
| roads only | 5 | 14 | `match` **and** `view` |
| **layout alone** | **85** | **341** | **`view` ONLY — `match` never loads it** |

**A click costs 4.5 seconds on a phone. A pan costs 1.1 s.** That is the problem this doc exists for;
the desktop numbers made it look like a nice-to-have.

**A speculation this falsified (mine).** I expected the text path to degrade *disproportionately* on a
phone — 29k lines split into millions of short-lived strings is allocation/GC-heavy, and mobile GC and
memory bandwidth are weaker than mobile compute. It doesn't: parse scaled **4.2×**, serialize 4.4×,
compute 4.2×, render 3.5× — everything moves together, so **the ranking does not reorder** and the
design below stands unchanged. *Caveat:* CDP throttling scales CPU only; it does not model memory
bandwidth, cache size, or a real GC. So this **weakens** the "text is disproportionately bad on mobile"
argument without fully killing it — a real-device run (§7) is the only thing that settles it, and no
phase below depends on that claim.

### Two premises this falsified

**1. "The text bridge is the front-end bottleneck" — stale.** `docs/loft-binary-bridge.md` asks loft for
a zero-copy bridge because `view` serializes *"~230k features to text … JS re-parses with `parseFloat`
over millions of coordinate strings."* loft **shipped** it (@PLN105 `deliver`/`expose`, verified working
here on both backends). But JS parse is **37 ms of 287** — 13%, and `match` emits **4 KB**, so a bridge
saves match *nothing*. The premise was true when `view` emitted the whole region; commit `199e7c7`
(viewport-scoped `view`) already fixed it. **The bridge's justification was removed by a different
change before the bridge arrived.**

**2. "loft must be in the view path" — false, and this is the big one.** `view` does no computing. Read
`map_kernel.loft`: it is `ring_hits()` (an integer bbox compare) plus `ring_text()` formatting every
coordinate as `"{lat:2.6},{lon:2.6}"`. The 124 ms is **formatting numbers into strings that JS
immediately turns back into numbers**. Meanwhile the 85 ms is loft **structurally re-validating a
static 20 MB file we ship ourselves — on every redraw**.

The store was designed for exactly this: *"a store file is its own serialization"* (HANDOFF's no-codec
bet). `store_load_url_trusted` **adopts the image**; it does not decode into some other shape. So the
bytes JS fetches ARE the records. **JS can read them.**

---

## 1. The decomposition — the two stores have different consumers

This is the structural fact the whole design turns on, and it was invisible until the decode was
measured per-command:

| store | size | `view` | `match` | verdict |
|---|---|---|---|---|
| **layout** (areas, buildings, lines, labels, pois) | 20 MB | ✅ | ❌ never | **pure data access → JS reads it directly. loft has no role.** |
| **roads** (TTile/TRoad/TStep) | 3.5 MB | ✅ (the R layer) | ✅ | loft needs it for Dijkstra; 5 ms to load, so it is not a cost |

So the app is not "loft does the map, JS does pixels". It is:

> **loft does the ROUTE. JS does the MAP.** Matching is real computation and belongs in loft. The base
> map is a bbox filter over records — it belongs where the pixels are.

---

## 2. Three families, not one invariant

One unifying rule ("never redo work") would be false here. These are three different problems, and only
one of them can be *wrong*:

| # | family | invariant | can it return a worse route? |
|---|---|---|---|
| **A** | **view path** | *The layout store is read, never decoded-then-re-encoded: JS reads the records; nothing serializes them to text.* | No — pure representation. Safe by construction. |
| **B** | **match cost** | *Cost is proportional to the graph actually needed, and the accuracy floor is never lowered.* (PLAN-MATCH §2) | **YES** — it trades against accuracy. Needs the §3 gate. |
| **C** | **validation lifetime** | *A static asset is validated at most once per session, never per redraw.* | No — pure subtraction. |

A and C are deletion; B is a quality-gated trade. That asymmetry is why B carries a gate and A/C do not.

---

## 3. Phase A — get loft out of the view path (246 ms of 287 ms)

**Do first: the largest win, and it cannot return a wrong answer.**

**Invariant:** *JS reads the layout records; nothing serializes them to text.*

**Re-assertion sites:** 1 per feature kind (areas / buildings / lines / labels / pois = 5). Omission is
**loud** — a kind that is not read is a kind that does not draw. `N × silence = 0`.

| step | change | verify |
|---|---|---|
| A0 | *(done)* `tools/map_profile.sh` + `__perfHooks` — the attribution instrument | the numbers in §0 reproduce |
| A1 | **Probe the enabling claim** (below) — can JS read the fetched image with a baked descriptor? | one PTile's `cover` + ring read in JS == the kernel's text for that tile |
| A2 | Bake the layout descriptor at build time (`LayoutDesc::to_json`, memoized per type — it is static). | descriptor emitted; JS loads it |
| A3 | JS reads ONE kind (areas) from the fetched buffer; kernel text path still runs; compare. | JS-read areas == text-parsed areas, feature-for-feature |
| A4 | Remaining 4 kinds; delete the text emit per kind as each is proven. | `# view:` counts identical; parse → 0 |
| A5 | Drop the layout store from the kernel command entirely. | kernel only ever loads roads (5 ms) |

**Predicted:** view 287 → **~30 ms** (render + a bbox filter over typed arrays). **Falsification probe
(A1 — run this before anything else):**

> Fetch `enschede.layout.store` in JS, hand `readLoftValue` (`doc/loft-deliver.js`) the fetched
> `ArrayBuffer` as its memory with the right `storeBase`, and read one known PTile. If it reconstructs
> the same `cover`/ring the kernel prints for that tile, the whole phase is real. **If the file image is
> NOT the in-memory image** — if `store_load` relocates, interns, or fixes up on adopt — then A is
> dead as written and the fallback is @PLN105 `deliver` (which reads the *adopted* image and still costs
> the 85 ms), worth ~160 ms instead of ~246 ms.

That single probe is the difference between a 10× view and a 1.8× view. **Run it first.**

**Risk:** JS then owns the layout format, so a store-format change (cf. loft#513) breaks the renderer
silently. Mitigate by keeping the kernel's text emit as a **test-only** path and gating
`JS-read == kernel-text` in `make test-map` — the parity gate *is* the format guard.

---

## 4. Phase B — validate at WRITE; load once; warm thereafter (85 ms × every redraw)

**Independent of A, and mostly subsumed by it — but the *warm* half is not, and it is the point.**

Two separate wastes are tangled here:

**(i) Read-time structural validation.** `store_load_url_trusted` skips the SHA pin but is *"still
structurally validated"*, so an 85 ms walk re-derives at **read** time a property the **generator**
already knew. That is backwards. The integrity fact belongs where the bytes are produced:
`tools/gen-tiles.loft` / the store builders should **stamp a checksum when they write the file**, and a
reader should verify that stamp — once — instead of re-walking 20 MB of structure. loft already has the
shape (`store_load_url(r, url, sha256)` takes a pinned hash); what it lacks is **"checksum-verified ⇒
skip the structural walk"**. That is a small, well-formed upstream ask, and routing is the consumer that
motivates it. (Cost check before asking: SHA-256 over 20 MB is not obviously cheaper than the 85 ms walk
— so the ask may be *a cheap checksum* (CRC32/xxhash) stamped at write, not SHA. **Measure both before
filing.**)

**(ii) Re-loading per interaction.** Even a free validation would not excuse re-loading a static asset on
every pan and every click.

**Invariant:** *integrity is established where the bytes are WRITTEN; a reader verifies a stamped value
at most once per session, and a warm interaction pays nothing.*

**Re-assertion sites: 1** — the kernel's command loop is the only place that loads. Omission is loud
(an empty store draws nothing).

| step | change | verify |
|---|---|---|
| B0 | **Measure a warm run** (see §4a) — today there is no warm number at all. | warm view/match reported separately from cold |
| B1 | Kernel keeps a session: load on first command, reuse after; the command blob drops the URLs. | profiler: warm view kernel ≈ 124 ms (serialize only), warm match ≈ compute only |
| B2 | Generator stamps a checksum at write; reader verifies it once. Upstream ask if "verified ⇒ skip structural walk" is needed. | cold load drops below 85 ms; a corrupted byte is still rejected |
| B3 | Invalidate on URL change (a different region ⇒ reload). | different store URLs re-load; no stale features |

**Predicted:** view 287 → ~200 ms *without* A; match's load is only 5 ms so it barely moves. **If A
lands, B's remaining value is the roads store's 5 ms — nearly nothing.** So **A supersedes B(i)** for the
layout; B0/B1's *warm* discipline stands regardless, because it is what makes every later number
readable.

**Risk:** a long-lived store pins wasm memory. Measure RSS; if 20 MB cannot be held, hold roads only —
which is what A leaves anyway.

---

## 4a. The instrument gap — every number in §0 is a COLD run

`runKernel` re-loads both stores on every call, so **there is currently no warm measurement of anything**
— and warm is the state the app is in for every interaction after the first. §0's table therefore
answers "what does a cold call cost", when the user-facing question is "what does a *redraw* cost".

The attribution in §0 lets us *predict* the warm numbers by subtraction — warm view ≈ 124 ms serialize,
warm match ≈ compute — but a subtraction is a hypothesis, not a measurement. The two can differ: a warm
store may sit in a different cache state, and §5's 3× match spread already hints that session history
affects cost.

**So B0 is a prerequisite for judging A and C, not a nicety.** Concretely: extend `__perfHooks` with a
session-mode kernel (load once, then N view/match commands) and report cold-first vs warm-subsequent
separately. Until that exists, every "predicted" column in this doc is arithmetic, not evidence.

---

## 5. Phase C — the match ladder (the ~1000–3100 ms)

**The real prize, and the only phase that can be wrong.** This is `PLAN-MATCH` §2–§5; that plan already
specifies the ladder, the §3 quality gate and the phasing, and does not need re-designing here. What
this doc adds: its step 0 (quality instrumentation) is **already done** (`match_quality()` emits the §7
numbers), and the app-level measurement confirms its premise — match compute is ~99% of a click's cost.

**⚠ First, fix the measurement.** Match kernel time was **1123 / 1017 / 3132 ms** across three profiler
runs of the *same* route. A 3× spread means the number is not yet trustworthy, and PLAN-MATCH's
acceptance ("drops toward ~300 ms") cannot be judged against a figure that moves 3×. **C0: make match
timing reproducible** (fixed route, warm/cold stated, N runs + spread reported, GC/memory-pressure
controlled) *before* tuning anything against it. Suspect first: the profiler runs match after 3 views +
2 decode probes, so wasm memory is already grown/fragmented — the earlier 1017 ms run had less
preceding work. This is a real finding about the *app*, not just the harness: if match cost depends on
what the session did before it, users will feel that.

| step | change | verify |
|---|---|---|
| C0 | Reproducible match timing (see above). | spread across N runs < 10% |
| C1 | Cell-tube corridor selection beside today's bbox; **both** available, bbox still default. | tube returns a subset; way-count drops; no behaviour change (inert) |
| C2 | Offline corpus compare: cheap vs fat tier on the §7 quality numbers. | table of (deviation, penalty share, class mix) per tier — the data that tunes the gate |
| C3 | Wire the §3 gate + escalation; fat corridor stays the floor. | where the gate accepts, quality tracks the fat tier (PLAN-MATCH §8) |

**Falsification probe (C2 *is* the probe):** PLAN-MATCH's own table shows the cheap tube returning a
*different, worse* route with **0 bridges**. If C2 shows quality diverging on a material fraction of the
corpus, the gate cannot be tuned to accept it and **the win is smaller than 3×**. Publish that fraction
before C3. Do not ship a gate tuned to a number nobody measured.

---

## 6. Order and predicted end state

```
B0 warm measurement + C0 reproducible match   ← the numbers everything else is judged against
        ↓
A1 probe: can JS read the fetched image?      ← decides A's size (10× vs 1.8×)
        ↓
A (view: loft out of the path)  →  C (the match ladder)
        ↘ B(i) checksum-at-write only if A1 kills A;  B1 warm-session stands regardless
```

**B0 and C0 come first** — not because they change anything, but because every other row of this table
is currently arithmetic rather than evidence (§4a), and C's acceptance cannot be read off a number that
moves 3× (§5). Measure, then move.

**Judge every row on the phone column.** A pan should feel instant (<100 ms) and a click should beat
~1 s; those are the budgets, and today's phone numbers (1121 / 4481 ms) miss both by 10×+.

| interaction | today **phone** | after A | after A+C | budget |
|---|---|---|---|---|
| `view` (pan) | **1121 ms** | **~150 ms** (render 76 + bbox filter) | ~150 ms | <100 ms — A gets close; render is then the floor |
| `match` (click) | **4481 ms** | ~4400 ms | **~1300 ms** (pending C2) | <1 s — **C alone does not reach it** |

Two consequences worth stating plainly rather than burying:

1. **A very nearly finishes `view`.** Deleting loft from the view path takes a pan from 1121 → ~150 ms,
   after which *render* (76 ms) is the floor and there is nothing left worth optimising.
2. **C alone does not finish `match`.** PLAN-MATCH's 3× takes a click from 4481 → ~1300 ms — better,
   still over budget on the target device. So the phone constraint says: C is necessary and **not
   sufficient**, and the next lever after it is not more corridor-tuning but **warm/incremental
   matching** (tier 0 — `covered()` + `match_incremental`, already ~40–68 ms on desktop) applying to
   more clicks, i.e. making the *cold* match rare instead of merely cheaper. That is a design question
   this doc opens and does not answer — deliberately, because C2's corpus data is what should decide it.

*(Warm columns deliberately absent: B0 has to produce them. Filling them in by subtraction is exactly
the move this doc is trying not to make.)*

**Re-run `tools/map_profile.sh` after every step.** The profile is the acceptance test: a step that does
not move the number it predicted is a step whose model is wrong, and that alarm gates the next step
rather than logging it.

---

## 7. Residual — what this design cannot see

One viewport, one route, one machine, headless, warm HTTP cache. Still not covered:

- **A real phone.** CDP throttling scales CPU only — not memory bandwidth, cache size, or GC. It is the
  best instrument available here and it says the ranking holds (§0), but a real device is the only thing
  that settles whether the text path degrades *disproportionately*. Cheap next step: run `_site` against
  a phone over `chrome://inspect` and re-run the same hooks.
- **Memory.** The phone's real constraint may be RAM, not CPU: a 20 MB layout store + wasm heap on a
  device that will evict the tab. **A's biggest un-costed win may be memory, not time** — if JS reads the
  store, loft never allocates the 20 MB at all. Nothing here measures RSS; it should.
- **Cold fetch.** The 85/341 ms is validation of an HTTP-*cached* store; a first visit adds download.
- **Session history.** §5's 3× match spread suggests earlier work affects later cost — on a phone, with
  less headroom, likely worse.
- **Zoomed-out viewports**, where the emit re-inflates and A's win grows.

Known-unknowns, not discovered ones — the axis list the next measurement varies.
