<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->

# The match — a line that grows, on all the cores

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-03 · **Owns:** the match ladder: presenting per point, the escalation, and `par` over the stretches

`PLAN-PERF` §3, §6b, §6b(3), §6e and §7. The matcher is **already per-point**; only its presentation
was monolithic, which is why the line can grow as it is computed. §3 is the phase that stopped the
app running loft's explicitly REJECTED one-shot model — the single fact that explained every bad
number. ⚠ §6e: `par` was a no-op in the browser when measured, and the capability has since landed —
read the 2026-07-29 addendum before assuming either state.

⚠ **Section numbers are global to `PLAN-PERF.md`** — they were not renumbered when this file was split out, so a citation of `PLAN-PERF` §7g still resolves. Its *Where each section lives* table says which file holds which §. **`PLAN-PERF` §0 is still the step list, and §1 the invariant every step is judged against.**

---

## 3. Phase S — stop using loft's REJECTED model (the bug)

**The root cause of every number in §2 is one architectural choice, and loft's own docs already reject
it.** `BROWSER_INTEROP.md` § *Rejected alternatives*:

> **Export loft `pub fn`s as wasm exports + a JS→loft call ABI** (the *"JS renders, loft computes"*
> compute-core model)… **Set aside because this model does not need them: loft owns the loop and the
> synchronicity lives inside the library via the yield.**

That is precisely what `browser/store-kernel.mjs` does — `runKernel(blob)` per request, one `loft_start`
per click, *"fresh Stores each call"*. **The app is built on the alternative loft rejected**, and both
symptoms fall straight out of it: no session (⇒ a full match per click) and a synchronous call on the UI
thread (⇒ a frozen frame).

**The intended model is shipped and proven.** § *"Pretend to be synchronous" — the gather-until-enough
contract*: loft owns the loop; a function gathers inbound bytes across as many frames as it takes and
returns the finished unit; the yielding is invisible to the caller. *"This is **already proven** — the
zero-trust `ztclient` transport does exactly it: `poll_for` loops `try_recv()` and calls `frame_yield()`
each pass."* `frame_yield()` ships in `web` (`loft-libs-net/web/src/web.loft:407`).

It gives **both** things this document needs, from one change:

| problem | how the loop model solves it |
|---|---|
| no session ⇒ full match per click | `main()` never returns, so stores / graph / MatchState live in its locals across commands. `loft_start` cannot reset what it never re-enters. |
| frozen frame | *"The single load-bearing rule: 'blocking' must mean yield-and-accumulate, never a hard spin"* — `frame_yield()` hands the frame back, so **the engine keeps rendering and taking input while loft waits**. |

**Invariant:** *loft owns the loop; state lives across commands; every wait yields the frame.*

**Re-assertion sites: 1** — the kernel's gather loop. Omission is loud (a hard spin freezes the page —
exactly issue #450's repro, which the yield contract exists to prevent).

| step | change | verify | revert |
|---|---|---|---|
| **S0** | **Probe, no product change.** ~20-line `--html` loft: `main()` loops, `frame_yield()`s, keeps a counter, echoes each command. Drive it with 3 commands. | counter persists across commands **and** rAF keeps firing during the wait | delete the probe |
| S1 | Kernel `main()` becomes the gather loop; stores loaded once into its locals. No algorithm change. | 2nd command drops ≈355 ms (view) / ≈14 ms (match); `frameBlocking` shows frames landing | one commit |
| S2 | Hold the corridor `Graph` across commands (built once). Still a full match. | 2nd match skips `build_graph` (~41% per PLAN-MATCH's split) | one commit |
| S3 | Hold `MatchState`; port `covered()` + `match_incremental` from `server/server.loft` — **it exists; do not rewrite it.** | **parity gate: incremental route == full-match route, byte-identical**; a one-point click ~10–20× cheaper | one commit |
| S4 | `view` re-emits only newly-exposed cells. | a small pan costs ≈ the new strip | one commit |

**S0 is the whole risk.** If a `--html` kernel cannot own the loop and yield (an asyncify constraint, a
`web`-lib dependency the store kernel does not have), S1–S4 are all fiction and the fallback is an
upstream ask. It is ~20 lines and it gates four phases. **Run it first.**

**Predicted (phone):** click **4481 → ~200 ms**, and the frozen gap → ~0 *without a Web Worker*.
**Falsification probe for the size:** the server's 40–68 ms is a *desktop, native* number over a tile
block. Land S3 alone and measure one warm click on the phone profile before designing S4 around it.

**Risk:** state goes stale (a moved point invalidating a cached window). `server/server.loft` already
solved this — `covered()` **is** that guard. Port its logic; do not invent a second one. The parity gate
in S3 is what proves the port.

---

## 6e. Step 18 — `par` is a NO-OP in the browser TODAY. Deferred, not dead. (2026-07-22)

**Step 18 cannot move a single number this plan measures *as things stand*** — the reason is a property
of the shipped artifact, not an opinion, and it was established BEFORE writing any loft, which is the only
reason no time was spent on it.

⚠ **But this is a DEFERRAL, not a dead end.** The maintainer confirmed (2026-07-22) that **loft has a plan
to allow `par` in browsers**; it was queued behind another bug. So the right posture is not "step 18 is
impossible" but "step 18 is waiting on a capability that is coming". **That capability has since ARRIVED —
see § "The capability landed" below** — and §6b B's determinism design is kept for that day, not as a
museum piece.

### The evidence, from the app's own wasm

```
kernel wasm: memory=DEFINED shared=false tlsExports=none noThreadsStd=true
```

- **The memory is not shared.** A wasm module with threads carries a SHARED memory (flags bit 1). The
  app's does not — there is no thread support in the module at all.
- **Rust's no-threads std was linked in.** `no_threads.rs` appears in the panic paths for mutex, rwlock
  and thread-local. The build had `threading` compiled OFF, not merely unused.

That matches loft's own `WASM.md`: the **WASM (single)** profile has `threading` **OFF**, and `par()`
falls back to **Tier 1 (sequential)**. Tier 2 (Web Workers) needs the `wasm-threads` feature *and*
**COEP/COOP headers**. `loft --html` — the only browser build, and the one
`browser/build-store-kernel.mjs` invokes — has no thread flag at all.

### And the deploy target cannot supply the headers either

Even if the build gained threads, Tier 2 needs COEP/COOP, and the app ships on **GitHub Pages**
(`PLAN-BUILD`), which does not let you set response headers. So the second gate is shut too.

### What step 18 would actually have bought

Its own verify line says *"~3× native on the stretch loop"* — **native**. That is `server/server.loft`,
which is not what this plan is about. In the browser the stretch loop is already streamed and
interruptible (step 16), so the sequential `par` would change nothing but the code.

**§6b B is not wasted and should not be deleted.** Its determinism analysis — order the source before
par, hash iteration is unordered, `gen` is loop-carried, keep reductions out of the workers — is exactly
right and is what step 18 would need on the day it becomes possible. It is a design waiting for a
platform, not a design that was wrong.

### The tripwire, so this does not have to be re-derived

`tools/wasm_threads.mjs`, wired into `make test-map`, asserts the state written above: if the app's kernel
ever gains threads, that gate FAILS and says to revisit step 18 — rather than this section quietly staying
wrong. *A blocked step should leave behind the check that unblocks it.* ⚠ **But read the next section
before trusting it as the CUE for step 18 — it is not one, and for eight weeks it could not even see a
threaded wasm.**

### The capability landed — verified, and the tripwire was BLIND (2026-07-29)

**loft's browser `par` ships.** @PLN117 ("browser multi-threading") is done and CI-gated upstream: `par`
runs on real Web Worker threads over shared wasm memory on one loft-owned runtime, `loft --html` picks the
threaded runtime when the program has a **reachable `par`**, and `--threads` / `--no-threads` override
(neither appears in `--help`). Confirmed here on the **installed** loft — `/usr/local/bin/loft`, reinstalled
2026-07-29 22:54, md5-identical to `../loft`'s build; `--version` still prints **2026.7.2**, so the version
string does not discriminate the binary.

Probe = loft's own `tests/wasm/html-thread-proof.sh` shape, driving the installed binary instead of the dev
tree (48-row `par` over a CPU-heavy `heavy()`, interpreter reference `par_sum=36023`):

| case | result |
|---|---|
| threaded bundle, COOP/COEP host | `coi=true` pool 24 · **`distinct_workers=8`** · `par_sum=36023` ✅ |
| **the same bundle**, host without isolation | `coi=false threads=0` · `distinct_workers=1` · `par_sum=36023` ✅ |
| `--no-threads` bundle, COOP/COEP host | `par_sum=36023` ✅ |

Static shape of the two bundles, which is what the gate has to recognise:

```
threaded   : IMPORTED memory env.memory shared=true min=17 max=16384 · __wasm_init_tls/__tls_size/__tls_align/__tls_base exported
--no-threads: DEFINED memory shared=false min=17 · no TLS exports        ← identical to today's store-kernel.wasm
```

Build cost is a non-issue (**0.7 s** threaded, 0.5 s sequential): the atomics std is prebuilt in
`/usr/local/share/loft/html-mt/`, so there is no cold `build-std`. Bundle 765 KB vs 626 KB.

⛔ **`tools/wasm_threads.mjs` reported that threaded bundle as SINGLE-THREADED.** It read the SHARED flag
out of the memory **section** — but a threaded wasm defines no memory, it **imports** a shared one, so the
section is empty and the check saw `memories=0 shared=?`, failed its `shared === true` test, and printed
`✓ single-threaded`. **Fixed:** the import section is parsed too, the TLS bootstrap exports are read out of
the export section as an independent second signal, and **three hand-assembled control modules
(imported-shared / defined-plain / TLS-only) are asserted on every invocation** — a detector that has never
been shown a positive case is a comment. Verified against all three real artifacts: today's kernel PASSES,
the real threaded bundle FAILS, the real `--no-threads` bundle PASSES.

**Two corrections this forces on the plan.** (1) The tripwire is **not the cue for step 18** and never
could be: it watches OUR artifact, and our kernel only gains threads once we add a reachable `par`. It is a
*regression* gate on this section's claim, not a *capability* detector — the toolchain moved on 2026-07-24
and it stayed green, correctly and uselessly. (2) The remaining blocker is entirely the **deploy host**:
Tier 2 needs COOP/COEP, GitHub Pages cannot send it, and the fallback is proven graceful
(`distinct_workers=1`, same value) — so the first piece of step-18 work is a **service-worker COEP shim**,
not `par` in the kernel. Until that exists, adding `par` buys the deployed app nothing.

*The pattern, for the fourth time in this plan: this was a probe no case ever exercised. It was written
against the shape of the artifact we HAD, so it could only ever confirm it.*

## 6b(3). Escalation emits the route TWICE — and step 16's headline number was stale (2026-07-22)

Both found by profiling §6b(2) immediately after shipping it, which is the only reason they were found
at all. The gates were green; the gates were also all running sketches that do not escalate.

### The measurement that did not match the document

| | step 16's row said | measured, twice, `CPU_THROTTLE=4` |
|---|---|---|
| 40-point sketch, stretches emitted | 39 | **78** |
| 40-point sketch, worst frozen gap | 384 ms | **2567 / 2773 ms** |
| 40-point sketch, total | — | **16.2 / 16.9 s** |

**78 is exactly 2 × 39, reproducibly** — so the route is matched twice. `do_match_session_streamed`
matches on the cell tube, and when the §3 gate rejects that tier it rebuilds on the fat bbox and re-runs
`match_incremental_streamed` with the same `on_stretch`. Every stretch is emitted once per tier.

**Nothing regressed: the document did.** Step 16's numbers were measured *before* step 22 wired the
ladder, and step 22 doubled the emit for any sketch whose tube is rejected. This is `CLAUDE.md`'s "a
spec's premise goes stale" rule landing on this plan's own table — the row was correct when written and
wrong eight commits later, and only re-measuring caught it.

### It was also a live defect in the renderer

`applyStretch` strokes onto the existing canvas, so a second pass left the **rejected tier still painted
under the accepted one**, and the slots blended: `route` briefly held new stretch 0 beside the rejected
tier's stretches 1..n — a line that was never matched. The delivered route was never wrong (the final
`ROUTE` replaces everything); what the user *watched* was.

Fix: **a non-increasing stretch index means a new pass** — clear the slots and repaint. A single pass
emits 0,1,2,… strictly increasing, so the indices already carry the signal; no kernel change, no second
channel. Gated **DOM-free** in `map.test.mjs`, because the browser gate structurally cannot reach the
case (it needs the ladder to *reject* a tier, and every sketch it uses is accepted first try), and
verified to FAIL without the fix before being kept.

### Two things this leaves open, neither urgent

- **A rejected tier is wasted work, and it is not small.** On the 40-point sketch the app pays a complete
  tube match *and* a complete bbox match. Whether that matters depends on how often real sketches get
  rejected — the 40-point probe is a straight synthetic line across 8 km, which is close to the worst
  possible case for a tube gate (a real drawn route follows roads, so it deviates far less). **Do not
  read 16 s as a user number.** Sizing it needs the §7h corpus, not this probe.
- **The 3-point profile is unaffected** (2 stretches, no escalation), which is why every headline number
  in this document's table still stands.

## 6b. The match arc — a line that GROWS, on all the cores

**This supersedes the framing of §7's ladder.** The ladder tries to make one big search cheaper. This
makes it *many small independent ones the user watches arrive* — which is both faster to first paint and
the shape `par` wants.

### The matcher is already per-point; only its presentation is monolithic

`build_state` is two passes, each a loop over INDEPENDENT items:

```loft
for i in 0..m       { anchors += [denoise_anchor(g, ct, i, ec, sc, gen)]; }         // per POINT
for i in 0..(m - 1) { subs += [assemble_stretch(g, ct, anchors, i, ec, sc, gen)]; } // per STRETCH
```

`subs` is *"one matched sub-path per stretch"*. The route IS a growing line already — it is just
collapsed into one blocking call and one final `ROUTE` line. Nothing here needs inventing; it needs
un-collapsing.

### The chunk size is already right (measured, native, one corridor)

| points | stretches | ways | total | **per stretch** |
|---|---|---|---|---|
| 3 | 2 | 13077 | 199 ms | **99 ms** |
| 10 | 9 | 13077 | 376 ms | 41 ms |
| 20 | 19 | 9376 | 540 ms | 28 ms |
| **40** (a real drawn route) | **39** | 9376 | 972 ms | **24 ms** |

A realistic route is **39 chunks of ~24 ms** (≈96 ms on a phone): long enough to dwarf dispatch, short
enough to stream. **Drawing more points makes each chunk cheaper AND the corridor tighter** (13077 →
9376 ways — `corridor_margin` scales with tap spacing). *Every other number in this document was measured
on a 3-point sketch — the pathological end: 2 huge stretches over the widest corridor.*

### A — present per point (fixes the lag; needs nothing from loft)

**Invariant:** *a stretch is drawn the moment it is matched; the user sees progress, never a stall.*

**And the progress is honest, not a decoration.** The route streams in the ORDER THE USER DREW IT, stretch
by stretch — so the line retraces the same gesture they just made. That is a progress indicator with no
indicator: it needs no spinner, no percentage, and no invented estimate, because the thing being shown IS
the work being done. A spinner says "something is happening"; this says "here is your route, arriving".
It also degrades honestly — a stretch that is slow to match is a stretch the user watches take its time,
which is information, not a stall.

**It also mimics the journey itself.** The stretches arrive in TRAVEL order, so the growing line is the
walk/ride unfolding in the direction the user will actually do it — a preview of the trip, not merely a
loading animation. This app is for planning a route you are about to travel; watching it draw itself
along the way you will go is the closest a plan gets to rehearsing it.

**So arrival ORDER is load-bearing, not incidental.** Emit stretches out of order and this stops being a
journey and becomes a jigsaw filling in — same pixels, none of the meaning. That is a real constraint on
B below, and the good news is it costs nothing: loft's `par(b=worker(a), N)` *"runs the worker in parallel
over the source and **iterates the results in order**"* (THREADING.md). Parallel work, sequential reveal —
the two compose exactly, and a stretch that finishes early simply waits its turn to be drawn.

Emit each `SubPath` as it lands and `frame_yield()` between them. First segment on screen in ~96 ms, then
~10 per second, the page painting throughout. **The 4.4 s does not shrink — it stops being a freeze and
becomes a line growing at a natural pace.** That is the difference between "hanging" and "loading", and
it is the whole of the lag problem (§0a): cost is a separate axis, addressed by B and §7.

Works today, on the single-threaded browser build, with no loft change and no route change.

### B — `par` over the stretches (fully utilise the processor)

**Invariant:** *each stretch is a self-contained chunk; workers share nothing, so nothing locks — and the
results are still revealed in travel order, for the same route as a sequential run.*

#### ⚠ `par` is NOT deterministic by default — and determinism is a design requirement

DESIGN §5 / PLAN-MATCH §2 require *same input → same match*. `par` does not give that for free. Three
sources, in the order they will bite:

**1. A `par` loop over a HASH visits in a different order.** THREADING.md: *"A hash uses an unsorted
bucket walk for par (`hash_unsorted`) since the queue has no use for the hash's key order — so a par loop
over a hash may visit elements in a different order than sequential `for x in h`."* `tiles_corridor_ways`
iterates `for t in store` — a `hash<TTile[tkey]>`. Par it and the **way order changes**, so `build_graph`
assigns different node/edge indices, so Dijkstra breaks ties differently, so **the route changes run to
run from identical input**. This is the dangerous one: it is silent, plausible, and only shows as a route
that "wobbles". *Fix:* do not par the corridor read, or materialise the tiles in `tkey` order first.

**2. `gen` is a loop-carried counter.** The stretch loop does `gen = gen + 1` and hands `gen` to
`assemble_stretch` to invalidate the shared `Scratch`. Under par that is a shared mutable and a race.
*Fix:* it disappears with B1 — a per-worker `Scratch` gets a per-worker `gen`, and neither is shared.

**3. Float summation order**, if any per-stretch cost is ever reduced across workers. Not an issue today
(each `SubPath` is independent and `emit_route` sums in order), but it is the classic way a parallel
refactor silently changes a length by 1e-12. *Fix:* keep every reduction in the ordered body, never in
the workers.

#### The shape that fixes it: ORDER THE SOURCE, then let par sequence the results

The two requirements — deterministic route, in-travel-order reveal — collapse into one rule, because
`par`'s *"iterates the results in order"* means **in the order of its SOURCE**:

1. **Give the source an ordering BEFORE par.** A range (`0..m-1`) already has one — which is why the
   stretch loop is safe as written. A **hash does not**: par materialises it with an unsorted bucket walk,
   so "in order" becomes "in an arbitrary order that may differ run to run". So the corridor read must
   either not be parallelised, or materialise its tiles **`tkey`-sorted** first. Sorting is the fix;
   par is not the problem.
2. **Emit the moment the next index lands** — index 0, then 1, then 2 — not when all workers finish.
   That is what keeps time-to-first-stretch low *with* par: the user still sees the line start growing
   immediately, while later stretches are computed behind it.
3. **Hold the ones that arrive early.** A worker that finishes stretch 5 before stretch 2 is done has its
   result kept until 2, 3, 4 land. That is a reorder buffer, and it is exactly what loft's `par` already
   does when it iterates results in order — so this costs us no code, only the discipline of (1).

The result: parallel work *behind* a sequencer. The compute order is whatever the scheduler likes; the
reveal order is the journey; the route is identical to a sequential run. A stretch finishing early simply
waits its turn to be drawn — and waiting costs nothing, because the user is watching the earlier ones.

**The buffer stays near the POOL size — but that is a tendency, not a hard bound.** The dispatcher is a
queue: while the head stretch is still running, the other N−1 threads keep pulling *further* work and
finishing it, so the pending set grows roughly as **(head cost ÷ typical cost) × N**, not N. It is close
to N in practice only because stretch costs are similar (measured: ~24 ms each across 39 stretches). Do
not design as if N were a guarantee:

- **Memory is still a non-issue, and does not depend on the bound holding.** Even the degenerate case —
  every remaining stretch buffered behind a stuck head — is ~39 `SubPath`s for a real route. Small
  whatever the jitter. loft's `par` owns the buffer; we do not size it.
- **The reveal stalls by the SLOWEST in-flight stretch, not a typical one.** That correction matters:
  costs are *not* uniform (a 3-point sketch's stretches are ~99 ms vs ~24 ms at 40 points — a 4× spread,
  and a stretch crossing a dense corridor is worse). So the pause is one *slow* stretch long, then several
  successors land at once. Still the honest-degradation property — the line hesitates exactly where the
  matcher struggled, and catches up instantly — but the pause is bounded by the worst stretch in flight,
  not by the average.

**And the luck cuts both ways — mostly in our favour.** Whether a slow stretch is felt depends on WHERE it
sits in the order:

- **Slow stretch at the head** → the worst case above: the reveal waits, successors pile up behind it.
- **Slow stretch late** → *invisible*. By the time the eye reaches stretch 30, the workers have been
  chewing on it for as long as the user spent watching stretches 0–29. It is already done.

So `par` hands every stretch a head start **proportional to how late it is** — and only the first few have
no head start at all. That inverts what the buffer is: **the pending results are not overhead, they are
LOOKAHEAD.** The work runs ahead of the eye, and the "buffer" is simply how far ahead it has got.

This is the real prize of par + ordered streaming, and it is bigger than the ~3× on the total. Sequential
streaming makes the reveal wait for each stretch in turn, so the line advances at `sum(costs)`. Par + an
ordered reveal makes the line advance at the pace the user watches, stalling only when the head is not yet
ready — i.e. cost is hidden behind attention rather than added to it. A route whose expensive stretches
are anywhere but the start can be *entirely* hidden.

So `par`'s non-determinism is bounded in the sense that matters most — the *route* becomes deterministic
once the source is ordered (1) — while the *buffering* is merely well-behaved: near-N under uniform cost,
degrading gracefully under jitter, never large enough to matter at route scale, and in the good case not a
cost at all but the lookahead that hides the work.

**The gate is therefore determinism, not just parity:** run the SAME match N times with par enabled and
assert the route is byte-identical every time — and identical to the sequential run. `tools/match_parity.sh`
already compares session-vs-one-shot on the route (excluding `ways=`, which is corridor size); the par
work extends it with an N-run repeat. A one-shot comparison would pass on a wobble that only appears one
run in ten, so the repeat is the point.

That is `par`'s core — divide the work into chunks big enough to be worth dispatching, with no shared
state. Per stretch the inputs are **read-only** (`g`, `ct`, `anchors`, `ec`) and the output is a fresh
`SubPath`. **Exactly one thing is shared and mutable: `sc` (the `Scratch` buffer)**, threaded through
every call and reused across iterations with a `gen` counter to invalidate it — a *sequential*
optimisation (reuse the buffer, don't reallocate) that is now the only thing forcing locking.

**Give each worker its own `Scratch` and the loop is embarrassingly parallel.** Same for Pass 1's
`denoise_anchor`, which shares the same `sc`. So the work is not "add threads to the matcher" — it is
**un-share one buffer**, which is also what makes it streamable.

> **MEASURED 2026-07-17 — the decomposition changes; `par` still works.** A par worker may not read a
> captured **reference**, only scalars — so `g`/`ct`/`anchors`/`ec` cannot be handed to a worker that way.
> But *"only the loop element may be a reference"* is the route: **put the data in the ELEMENT** — make
> each stretch a self-contained job carrying the slice it needs. That is the ordinary data-parallel
> decomposition, and measured it scales:
>
> | slice per job | sequential | `par(…,8)` | |
> |---|---|---|---|
> | 100 | 96 ms | **26 ms** | **3.7×** |
> | 1000 | 88 ms | **22 ms** | **4.0×** |
> | 10000 | 69 ms | 42 ms | 1.6× — the per-element copy eats it |
>
> Results identical throughout. **So the constraint is: give a worker what its part needs, not the world,
> and keep the slice small** — the element is copied into the worker's isolated store clone.
>
> Two corrections to what this section assumed: (a) **we were never blocked on `Scratch`**, the shared
> *mutable* — the pressure is on the read-only *inputs*; (b) the work is not "un-share one buffer" but
> "**slice the corridor per stretch**". Sizing that slice is the open design question, and the copy column
> above is what decides it. §6b A (streaming) is unaffected and already shipped — it was always the half
> that fixed the lag. THREADING.md: *"`Stores::clone_for_worker()` creates **locked copies of all in-use stores for
> each worker thread**."* Two consequences, pulling opposite ways:
> - **The un-sharing may be automatic.** If each worker gets private stores, `Scratch` is already
>   per-worker and step 17 is a no-op. Refactoring it by hand first would be work done for nothing.
> - **But it copies ALL in-use stores, per worker** — including the corridor `Graph` (13077 ways). Eight
>   workers ⇒ eight graph copies. That could cost more than the ~3× it buys, and it is a *memory* cost on
>   the device where RAM already binds (the session is at 188 MB).
>
> So **measure before refactoring**: run `par` over the stretch loop as-is and read (a) wall clock vs
> sequential, (b) `wasmBytes`, (c) whether the route stays byte-identical. That probe answers whether
> step 17 is needed, unnecessary, or moot because 18 is too expensive. Doing 17 first assumes an answer
> the docs already put in doubt. *(Extra context args ARE forwarded — `par(b = scale(a, mult), N)` — so a
> worker can take `g`/`ct`/`anchors`/`ec`; that part of the design holds.)*

Measured ceiling: `par(…, 8)` gives **3.3×** natively here (101 → 31 ms on a synthetic load). On a phone's
8-core big.LITTLE expect ~3× — the 4 little cores are not equal to the prime one, and the thread count
should come from `navigator.hardwareConcurrency`, never a constant (this box reports 24).

**Browser gating (measured, not assumed):** threads need `crossOriginIsolated`, which needs COOP/COEP.
Our own page, same bytes:

| served | `crossOriginIsolated` | `SharedArrayBuffer` |
|---|---|---|
| no headers (as GitHub Pages serves it) | `false` | undefined |
| + COOP/COEP | **`true`** | **`function`** |

Two response headers are the whole difference. GitHub Pages sends no custom headers, but a **service
worker can inject them** (the `coi-serviceworker` pattern; the older `browser/` app already shipped an
`sw.js`). The real gate is loft-side: today's `--html` wasm **exports an unshared memory** and the shim has
no workers/SAB/atomics — loft's `C3` (*"WASM threading deferred — Web Worker pool cost > benefit today"*)
and roadmap A10 8a. **Flag for that work:** our kernel now leans on asyncify for both the store fetch and
`frame_yield`, and BROWSER_INTEROP calls asyncify *"one suspendable stack"* — threads plus one suspendable
stack is exactly where this goes quietly wrong. Probe that combination first.

#### B2 — what "slice the corridor per stretch" actually requires (read before coding)

`assemble_stretch` is `dijkstra_win(g, ai, [aj], win, ec, sc, gen)` — `ai`/`aj` are node **indices into
g**, and the search walks the whole graph bounded by the deviation window `win`. To make a stretch a
self-contained job (the only shape `par` accepts — see B above) each job must carry its own sub-Graph.
Three things follow, and the second is the one that bites:

1. **The envelope must be a SUPERSET of what the full search would touch**, or the route changes. The
   natural candidate is the deviation window itself (`win` + `DEV_TOL`), since that is what bounds
   `dijkstra_win` — but "what the search *could* reach" needs proving, not assuming. Too tight and the
   route silently degrades; too loose and the copy cost (B's table: 10k elements ⇒ the win is gone) eats
   the parallelism. **That trade IS step 18a.**
2. **Renumbering must be MONOTONIC.** A sub-Graph renumbers nodes, and the search's tie-breaks depend on
   node/edge indices — the same mechanism as the hash-ordering hazard above. If the subgraph's nodes keep
   the parent's *relative* order, equal-cost ties resolve identically and the route is preserved; an
   arbitrary remap changes which of several equal-cost paths wins. So: build the slice **in parent index
   order**. This is cheap to do and silent to get wrong.
3. **The path must map back** to parent indices/coords before it reaches `SubPath`.

**Do not start 18b before 18a answers (1).** The gate (`match_parity.sh`) would catch a wrong envelope,
but only as "the route changed" — it will not tell you which envelope is right, and this is a design
question with a correctness answer, not a tuning knob.

**And weigh it against what streaming already bought.** §6b A took a real route's worst freeze from
11095 → 744 ms with no threads. `par` shortens the *total* (~4×), which the lookahead already hides for
every stretch but the first few. The honest case for 18 is now the **cold match** (~5.3 s, the first
click in a fresh area) — the one thing streaming cannot hide, because there is nothing on screen yet to
watch. Steps 19–20 (persist the built graph, cell-tube corridor) attack the same number without touching
the matcher's internals or risking a route. **Do those first, and re-measure before committing to 18.**

### Order

```
A  stream per stretch + yield        ← fixes the LAG. No loft change, no route change, works today.
B1 per-worker Scratch                ← un-share the one mutable. Prerequisite for par; no behaviour change.
B2 par(…) over stretches             ← ~3x on native/Android today; browser gated on loft C3 + COOP/COEP.
```

A is independent of everything and should land first: it is the only one that changes what the app *feels*
like, and it needs no permission from anyone.

---

## 7. Phase C — the match ladder (the rare cold match)

`PLAN-MATCH` §2–§5, unchanged; its step 0 (quality instrumentation) is already done (`match_quality()`).

**Rare is not an excuse for slow.** S makes the cold full match the *outlier* — a first click, or a
sketch leaving the built corridor — but a user still hits it on every fresh area, and 4.5 s is not
acceptable there either. The outlier needs a budget too: **≤ ~500 ms on a phone.** Two levers get it
there, and they compose:

| lever | what it removes | size |
|---|---|---|
| **C1–C3** — the cell-tube ladder | ways in the corridor (20,472 → 6,945) | ~3× on both build and search |
| **C4** — persist the BUILT graph (`PLAN-TILES` §268) | `build_graph` entirely | **~41%** of a cold match |

That 41% is not a guess — PLAN-MATCH's own table splits the 886 ms cold match as **build 367 + search
519**. The graph is derived data with a static input (the tile block), so building it per match is the
same §1 violation as everything else in §2: *work proportional to the data, not to the change.* Building
it at **generation** time and loading it is the write-time move Phase B makes for integrity.

Composed: tube (~3×) on a search that no longer pays build ⇒ **4370 → ~500 ms**, without touching the
accuracy floor. **C4 does not need the §3 gate** — it changes no route, only where the graph comes from —
so it is safe to do *before* C3, and it is the better first step.

**⚠ C0 first — the number is not trustworthy.** Match kernel time was **1123 / 1017 / 3132 ms** across
runs of the *same* route. A 3× spread cannot judge "drops toward ~300 ms". Suspect session history (wasm
memory grown/fragmented by preceding views). That is itself a finding: if cost depends on what the
session did before, users feel it.

| step | change | verify |
|---|---|---|
| C0 | Reproducible match timing (fixed route, warm/cold stated, N runs + spread). | spread < 10% |
| **C4** | **Persist the built graph** (PLAN-TILES §268): build at generation, load it. Route-neutral ⇒ no gate needed ⇒ do it FIRST. | identical route; cold match drops ~41% |
| C1 | Cell-tube corridor beside today's bbox; both available, bbox default (inert). | way-count drops; no behaviour change |
| C2 | Offline corpus compare: cheap vs fat tier on the §7 quality numbers. | the data that tunes the gate |
| C3 | Wire the §3 gate + escalation; fat corridor stays the floor. | where the gate accepts, quality tracks fat |

**Falsification probe (C2 is the probe):** PLAN-MATCH's own table shows the cheap tube returning a
*different, worse* route with **0 bridges**. If quality diverges on a material fraction of the corpus,
the gate cannot accept it and the win is smaller than 3×. Publish that fraction before C3.

**C3 is the only step in this document that can return a worse route.** Everything else is subtraction.

---
