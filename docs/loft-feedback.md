# loft feedback from the `routing` consumer

**Date:** 2026-07-01 · **loft:** 2026.6.0 (git `e7c0f17b`) · **libs:** `loft-libs-net/web` 0.1.1 (local) / 0.2.0 (registry)
**Last updated:** 2026-07-06 — see the dated sections at the bottom; the CURRENT upstream asks are
consolidated in *"2026-07-03 — remaining upstream blockers"*.

`routing` (a phone-first route planner) consumes loft as a **native server** (v1) and, later, as a
**WASM compute kernel in the browser** (`--html`, for an offline/no-server mode). While scoping that
integration we hit **one capability gap** and **seven documentation gaps**. This is a hand-off a loft
agent can implement/fix directly — every claim below was *tested*, with file:line refs.

**Priority note:** the capability gap (Part 1) blocks **only an offline, no-server browser build**.
With a loft *server* (the `server` lib's WebSocket, exactly as `tools/audience-demo` does), the browser
is thin JS and loft runs **native** with full HTTP/fs — the gap doesn't bite, and that's the path
routing ships first. Part 1 is what makes the **offline** path (and any headless-browser-compute
consumer) possible — loft already has a *design* for it (`BROWSER_INTEROP.md`) that was never shipped.
**Part 2 (doc gaps) is worth fixing regardless** of routing's choices.

---

## PART 1 — Capability gap: no generic JS→loft input for `--html` (blocks only offline/no-server browser use)

*Scope:* a loft **server** sidesteps all of this (thin JS browser ↔ native loft over WebSocket — the
audience-demo shape). This matters when loft must run **in the browser with no server to talk to** —
an offline/pure-static compute kernel.

### What we found (all verified)

- **`--html` ships OUTPUT but no generic INPUT.** A `--html` build exposes host imports for output
  (`loft_io.loft_host_print`) and GL (`loft_gl.*`) — nothing else. Verified by dumping the wasm's
  imports: a program that calls `file()` **and** `arguments()` imports *only*
  `loft_io.loft_host_print` + `loft_gl.host_asset_exists`. So under `--html`, `file()`/`arguments()`
  compile to **in-wasm stubs** (no host call, return empty) — there is no shipped way for JS to hand
  bytes to a running loft program.
- **`web`'s HTTP client is native-only — no browser bridge.** `web/src/web.loft` declares
  `#native http_do`/`http_body`, but:
  - `web` 0.1.1 (local `loft-libs-net/`): `wasm/src/lib.rs` has **51** `ws_*` symbols and **0** http;
    its `[wasm.bridge].routes` route the WebSocket calls, `pack_*`, `yield_frame` — **`http_do`/
    `http_body` are absent**.
  - `web` 0.2.0 (registry tarball): has **no `[wasm.bridge]` block and no `wasm/` directory at all** —
    no browser bridge of any kind.
  - So `http_get`/`http_post`/… work on `--interpret`/`--native`/`--native-wasm` but **cannot run in
    `--html`**. Overpass-style fetch (and the "blob-URL local input" trick that would lean on it) are
    impossible in the browser today.

**Net:** a loft library that wants to be a *headless browser compute service* — points/bytes in from
JS, result out to JS, called request/response from a Web Worker — **cannot receive its input under
`--html`** without every consumer hand-rolling a per-app `[wasm.bridge]` crate. Only two `--html`
"apps" are first-class today: **GL apps** (canvas + keyboard/mouse) and **WebSocket clients**.

### What to implement

**Option A — a generic `loft_io` INPUT primitive, symmetric to `loft_host_print` (RECOMMENDED).**
This is the shipped realization of the push/poll **byte channel** that `doc/claude/BROWSER_INTEROP.md`
already designs but never shipped (it says so itself at line 9). Concretely:

- Add a host import to the `--html` set — e.g. a poll pair `loft_io.poll_len(channel) -> i32` +
  `loft_io.poll_copy(channel, ptr) ` (the exact shape BROWSER_INTEROP.md proposes), or a simpler
  `loft_io.host_input(ptr, cap) -> i32`. Wire it in the `--html` codegen host-import set and implement
  it in **`doc/loft-gl-wasm.js`** (`buildLoftImports`, ~line 114 — add next to `loft_host_print`) so
  JS can push bytes to loft.
- Expose it in the stdlib as e.g. `pub fn host_input() -> text` (or a byte-channel read), so pure-loft
  code can read JS-provided input on every target (native/WASI can back it with stdin/args; `--html`
  with the new import).
- Suggested files: `src/main.rs` (`--html` assembly / host-import wiring, ~5359–5862 & the flag at
  3800), `src/generation/` (cdylib entry + host-import emission), `doc/loft-gl-wasm.js`,
  `default/*.loft` (stdlib surface), and mark it shipped in `doc/claude/BROWSER_INTEROP.md` +
  `HTML_EXPORT.md`.
- **Acceptance (the parity gate):** a `--html` program that reads host input and prints a transform of
  it; a headless-Chromium harness posts bytes and reads the printed result; the value must equal
  `--interpret`/`--native`/`--native-wasm` on the same input. (routing has a headless-Chromium harness
  pattern and a WASI parity harness — `tools/kernel_headless_test.sh` — we can share.)

Why A is the right general fix: with a generic byte channel, **JS owns all network** (JS `fetch` for
Overpass is trivial) and hands loft the bytes; loft stays pure compute. That matches loft's own
"engine as an agnostic byte mover" invariant (`BROWSER_INTEROP.md` §"The one invariant") and needs no
browser HTTP in wasm at all.

**Option B — add an HTTP browser bridge to `web` (narrower, still useful).**
Route `http_do`/`http_body` in `web`'s `[wasm.bridge].routes` and implement them in
`web/wasm/{src/lib.rs,host.js}` via `fetch()` + asyncify. The existing **WebSocket** bridge is the
exact template; HTTP is blocking, so it needs a dedicated asyncify suspend import (the `ws_yield`
pattern — see `references/wasm-bridge.md` "asyncify trap"). This unblocks browser HTTP directly, but
only for HTTP-shaped input; Option A is the general channel.

---

## PART 2 — Documentation gaps (concrete fixes)

1. **`--html` is undocumented in `loft --help`.** The flag exists (`src/main.rs:3800`) and is a primary
   browser path, but it's absent from the printed help (which lists `--native-wasm` but not `--html`).
   Add it.

2. **The two wasm "worlds" are conflated.** There are two distinct browser-wasm builds with *different*
   host surfaces, and the docs don't delineate them:
   - **`--html`** → `wasm32-unknown-unknown` cdylib, driven by `doc/loft-gl-wasm.js`; host imports =
     `loft_io.loft_host_print` + `loft_gl.*` only. **No filesystem, no args, no env.**
   - **IDE `make wasm`** → wasm-bindgen build with the `globalThis.loftHost` filesystem/args/env
     bridges documented in `WASM.md § Host Bridge API`.
   `WASM.md`'s Host Bridge API reads as if it applies to *all* wasm; it does **not** apply to `--html`.
   This directly misled our scoping (a reader concluded `--html` has a filesystem). **Fix:** state up
   front which build each host bridge belongs to, and have `HTML_EXPORT.md` list *exactly* the host
   imports `--html` provides (print + GL, full stop).

3. **`BROWSER_INTEROP.md` status could be louder.** It *does* say "design doc, not yet a shipped
   reference" (line 9) — good — but the "sanctioned loft browser model" framing elsewhere invites
   over-reading it as shipped. Add a top STATUS banner: *shipped today* = asyncify yield + `web` WS
   bridge + `loft_host_print`; *not shipped* = the generic push/poll byte channel and any JS→loft
   input. (Part 1 Option A is what would flip this to shipped.)

4. **`web`'s per-function target matrix is misleading.** `http_get/post/put/delete` are in the public
   API with no hint they're native-only; a consumer reasonably assumes they work in `--html` (they
   don't — see Part 1). **Fix:** mark `http_*` as `{interpret, native, native-wasm}` only in the `web`
   README/API surface, and note **WebSocket is the only browser-bridged transport**. (The loft-ship
   skill's "don't claim a target you haven't passed the gate on" applies per *function*, not just per
   library.)

5. **`--native-wasm` size/target guidance is missing.** `wasm32-wasip2` links full `std` + WASI + a
   component adapter and is **not** `wasm-opt`'d, so it is ~4× heavier than the `--html` cdylib.
   Measured on the same `routing_kernel` client: **`--html` = 1.1 MB / 330 KB gz** vs **`--native-wasm`
   = 5.4 MB / 1.5 MB gz** (2.1 MB core even after `jco -O` + `wasm-opt`). **Fix:** `WASM.md` should say
   *for the browser use `--html`* (small no-std engine); `--native-wasm` is for WASI/headless
   (wasmtime) and is much larger. Also note `--native-wasm` **compiles only** (doesn't run) — it needs
   an external runtime (wasmtime), which `--help` doesn't mention.

6. **`server` AND `web` do not compile under loft 2026.6.0 — this BLOCKS every consumer (HIGH).**
   Not a papercut: a `text`-returning function does `return null`, which is now a hard error
   (*"`null` cannot be stored into the return value of the non-null scalar type `text` — declare it
   `text?`"*). Confirmed in **every** version available:
   - `web/src/web.loft` `pub fn try_recv(self: WsHandler) -> text { … return null; }` — in 0.1.1,
     0.2.0, 0.2.1, **0.2.2** (its own doc says "null otherwise", so the return type is simply wrong).
   - `server/src/server.loft` `pub fn next(self: WebSocket) -> text { … return null; }` — 0.2.0.
   Because `server` depends on `web`, **any `use server;` fails to build.** The audience-demo only
   works because it was built under an older loft. **Fix:** change both signatures to `-> text?`
   (the error's own suggestion; one line each), bump patch versions, and republish. Until then a
   consumer must vendor + patch (which routing had to do — `lib/{server,web}`). This should probably
   gate the registry: no shipped package should fail to compile on the current stable loft.

7. **`~/.cache/loft` staleness gotcha** (already documented at `WASM.md:686`) bit us when iterating
   `--html` after an `--interpret` run of the same program — the fix (`rm -rf ~/.cache/loft`) works.
   Good that it's documented; `WASM.md` already flags auto-invalidation as a candidate fix — worth
   doing, it's a sharp edge.

8. **Perf: nested-vector element mutation via a `&` ref is O(n²) with a hash in the struct — FILED
   [loft-lang/loft#475](https://github.com/loft-lang/loft/issues/475).** The idiomatic incremental
   adjacency list (`adj: vector<vector<int>>`; `adj[a] += [e]`) mutated through a `&Graph` ref is
   O(size-of-struct) per call when the struct also holds a `hash` — a 100-node graph build hung
   > 20 s. Workaround: flat edge list. This makes graph algorithms a trap for the natural
   representation; worth an interpreter fix (probably a whole-struct deep-copy on nested-element
   mutation through a reference).

---

## What routing does

- **Server-first** (decided 2026-07-01): loft runs **native on a server** (`server` + `web` +
  `routing_kernel`), the browser is thin JS + Leaflet over a **WebSocket** (audience-demo pattern).
  This needs **none** of Part 1 — HTTP (Overpass), files, persistence, and heavy compute all work
  natively on the server.
- **Kernel compute is proven portable** (pure loft; `lib/routing_kernel`): `--interpret == --native ==
  --native-wasm`, byte-identical, matching the JS haversine to full f64 precision
  (`tools/kernel_headless_test.sh`) — so the same code runs on the server now and in a browser kernel
  once Part 1 lands.
- **Offline/standalone (loft in the browser) is deferred** and is the one path that wants Part 1.

---

## 2026-07-02 — one-judgment typing: the reported `--dump` divergence, investigated

**Reported (this session):** `loft --dump` accepted `client/kernel.loft` while `--interpret` and
`--native-wasm` rejected the identical program — suggesting the null-discharge (N-Store) check is
not anchored at a single phase, and that a formal definition must state well-typedness as **one
static judgment, independent of backend or invocation mode**.

**Investigated in the loft tree (both binaries × both modes, on the PRE-migration `kernel.loft`
= `git show 20290ae:client/kernel.loft`, the version that carries the undischarged
`xy[0] as float` sites):**

| binary | `--interpret` | `--dump` |
|---|---|---|
| `/usr/local/bin/loft` 2026.6.0 (PATH) | accepts, exit 0 | accepts, exit 0 |
| dev build (`workspace/loft`, DN1 + parse-flip) | **rejects**, exit 1 (2× `float?` N-Store) | **rejects**, exit 1, same 2 errors |

No single binary diverges: `--dump` runs the same two-pass parse (+ bytecode) and rejects
identically. The parsimonious explanation for the observed split is **two different binaries** —
the installed `loft` on PATH (2026.6.0, which predates the DN1/N-Store checks entirely) answering
one invocation and the dev build answering the other. Consumer sessions should pin
`which loft` when comparing modes; only the dev build carries the DN1 model until the next release.

**The class is still real.** A same-day in-tree instance: a whole-file CLI run whose FIRST-pass /
lexer errors abort compilation never *reports* the second-pass (N-Store) family — the exit is
still 1, so soundness holds, but the **diagnostic set is phase-dependent** (the test harness runs
both passes and sees errors the CLI never prints). That is the lesser sibling of the reported
wrinkle: judgment-stability across drivers is a property that needs a guard, not an assumption.

**Where it landed in the formal register:** the loft repo's differential oracle (@PLN89,
`formal/ROADMAP.md` D1) now explicitly includes **driver agreement** in scope — for each corpus
program, accept/reject must agree across `--interpret` / `--dump` / `--native` / `--native-wasm`,
alongside the existing runtime value/null/halt/stdout/leak agreement. A future divergence of this
kind then fails a test instead of surfacing in a consumer session.

---

## 2026-07-02 — native: `float?` return corrupted by a CONSTRUCTED text argument (silent 0)

Found building the step-15 elevation kernel (dev build HEAD `8aa25f9c`). Under `--native`, a fn
returning `float?` that is CALLED with a **constructed** text argument (interpolated `"{n}"`)
returns **0** to the caller instead of the real value. A **literal** text argument is fine;
`--interpret` is fine in all variants. Binding the interpolated text to a local first does NOT
avoid it — the trigger is the constructed text VALUE in the argument list, not the syntax.

20-line repro:

```loft
fn get(v: vector<float>, key: text) -> float? {
  if key == "5" { return v[0]; }
  null
}

fn mid(v: vector<float>) -> float? {
  n = 5;
  get(v, "{n}")
}

fn main() {
  v: vector<float> = [];
  v += [42.5];
  h = mid(v);
  if h != null { println("h={h ?? -1.0} (expect 42.5)"); }   // native prints h=0
  else { println("h=NULL"); }
}
```

| variant | arg | `--interpret` | `--native` |
|---|---|---|---|
| literal | `get(v, "5")` | 42.5 | 42.5 |
| interpolated | `get(v, "{n}")` | 42.5 | **0** |
| interpolated + cast | `get(v, "{floor(x) as integer}")` | 42.5 | **0** |
| via local | `k = "{n}"; get(v, k)` | 42.5 | **0** |

**Why this one bites the null model:** the corruption is a NON-null `0` — the caller's
`h != null` takes the not-null branch and `?? 0.0` yields 0, so there is nothing to defend
against; every downstream float silently flattens. In routing this made every elevation sample
read 0 m while the 22-sample structure looked perfectly healthy.

**Second manifestation (not minimized):** the same call shape inside a `use`d library also
returned zeros under a plain `--interpret` run while passing under `--tests` — worth re-checking
once the native fix lands; if it doesn't explain it, we'll minimize that one separately.

**Workaround (clean, applied):** keep constructed text out of nullable-returning call argument
lists. `routing_kernel`'s tile lookup now keys tiles by INTEGER coords
(`t.tx == tx && t.ty == ty` — no per-sample text at all), green on both backends; the "z/x/y"
text keys survive only in the server-facing fetch API (`tile_key`, `elev_tiles_for`).

---

## 2026-07-02 — native: `text as integer` from a discharged text LOCAL emits invalid Rust (E0605)

Same session, server side. With `parts = key.split('/'); txs = parts[1] ?? "";` the parse
`tx = txs as integer ?? -1;` makes `--native` emit
`let mut var___ncc_4: DbRef = (&var_txs).parse().unwrap_or(i64::MIN) as DbRef;` → rustc E0605/E0308
("an `as` expression can only be used to convert between primitive types"), i.e. the parse target
is typed `DbRef` instead of `i64`. Interpret runs it fine. Parsing the nullable index expression
**inline** — `tx = parts[1] as integer ?? -1;` (the `parse_points` shape) — codegens correctly, so
the trigger is specifically a *plain text local* (itself produced by a `??` discharge) as the
`as integer` source.

Also worth knowing: `--native-emit` succeeded on this program — the failure only surfaces at the
rustc stage, so an emit-only check is NOT a native-build gate.

**Workaround (applied):** parse vector elements inline (`v[i] as integer ?? d`) instead of via an
intermediate discharged local (server/server.loft `add_tile`, with a pointer comment).

---

## 2026-07-02 — parser ICE: float format with precision 0 (`"{m:1.0}"`)

3-line repro (step-17 session, same dev build):

```loft
fn main() {
  m = 850.5;
  println("{m:1.0}");   // panics: src/parser/collections.rs:1097:45 unwrap on None
}
```

`{m:1.1}` and `{m:4.2}` are fine; only **precision 0** panics — an ICE, not a diagnostic, so a
consumer sees a raw `Option::unwrap()` backtrace with no source location.
**Workaround (applied):** round through an integer for whole-number display:
`"{round(m) as integer} m"` (server/server.loft `nice_length`).

## 2026-07-02 — native: text-returning TAIL CALL of a fn with a HEAP param emits `Str::new(&Str)` (E0308)

A `-> text` function whose TAIL expression calls another `-> text` function miscompiles under
`--native` **when the callee takes a store-backed param** (here `JsonValue`): the generated
`return Str::new(&n_jtext(cell, var_root, "b"))` double-wraps an already-`Str` value → rustc
E0308. The trivial all-`text` case (`fn inner(s: text) -> text { s }` tail-called) does NOT
reproduce — the heap param is part of the trigger. Earlier explicit `return jtext(...)` calls in
the same function are fine; only tail position breaks. Interpret runs it (with, incidentally, a
`1 stores not freed at program exit: kt=65535` warning on this shape — possibly its own minor
store-lifetime wrinkle).

```loft
fn jtext(obj: JsonValue, name: text) -> text {
  v = obj.field(name);
  if v.kind() == "JString" { v.as_text() } else { "" }
}

fn pick(root: JsonValue) -> text {
  nm = jtext(root, "a");
  if nm != "" { return nm; }
  jtext(root, "b")      // --native: return Str::new(&n_jtext(...)) → E0308
}

fn main() {
  println(pick(json_parse("{{\"b\":\"world\"}}")));
}
```

**Workaround (applied):** bind then return — `nm = jtext(addr, "city"); nm` (server/server.loft
`area_name`, with a pointer comment). Same family as the morning's two (both since fixed
loft-side): return-position codegen around wrapped/heap values is the recurring theme.

---

## 2026-07-02 (later) — BOTH native bugs above FIXED in the loft tree (branch `tuxedo-pln85-ownership`)

Follow-up from the loft side; both repros verified fixed on both backends, with regression
guards in `tests/scripts/`.

**1. `float?` return corrupted by a constructed text argument — FIXED.** Root: a `-> τ?`
(Optional scalar/text) function whose tail is a call with pending scope free-ops (the
constructed text's `__work` free) fell through the parser's B5-L3 return-wrap — the type
check (`is_value_return_type` + the text arm in `scopes.rs::free_vars`) matched bare scalars
but not `Optional(scalar)`. The tail call was emitted as a DISCARDED statement plus a
fabricated `return null`; interp read stale top-of-stack (accidentally right), native
faithfully returned `0.0` — the silent non-null you saw. Fix: peel `Optional` in both type
checks (`tp.base()`), so the `__ret_N` claim-wrap fires. Guard:
`tests/scripts/85-optional-return-freeops-tail.loft` (float?/integer?/text? × value/null
paths, both backends, leak-clean). Your tile-keying workaround is no longer required
(though integer keys are the better design regardless).

**2. `text as integer` from a discharged local → E0605 — FIXED, and it was WORSE than
filed.** Reproducing your exact `add_tile` shape (void fn + early returns + a later
DbRef-typed `??` like `png() ?? Image {}`) showed interp ALSO computed a silently wrong
value (`tx` became 0) — not just a native compile error. Root: the two-pass parser can
materialise a different SET of `??` temps per pass, so the `__ncc_N` counter denotes
different sites per pass; the variable-table reuse then handed pass-2 code a temp carrying
pass-1's TYPE (your `tx` parse temp held `ref(Image)` — hence `parse() .. as DbRef`).
Fix: on generated (`__`-prefixed) temp reuse, pass 2 wins on a type conflict
(`variables/mod.rs`). Guard: `tests/scripts/85-ncc-temp-crosspass-type.loft` (your
add_tile shape distilled). The inline-parse workaround in `server/server.loft::add_tile`
can be reverted at the next loft update, or kept — both forms now compile and run
correctly.

Probe-hygiene note for future matrices: `??` binds LOOSEST, so
`assert(v[0] ?? -1 == 34)` parses as `v[0] ?? (-1 == 34)` and is vacuously true under
interp truthiness — parenthesise the discharge: `(v[0] ?? -1) == 34`.

---

## 2026-07-03 — remaining upstream blockers (routing is otherwise feature-complete)

All 20 plan steps plus the post-v1 sweeps (full candidate-set matcher, tight corridor, draft-save
undo, WGS84 geodesic, crosshair/retrace/box-select) are done. Exactly TWO consumer features remain
blocked, both on loft-level primitives — everything below was hit and measured this session, not
scoped from docs.

### 1. Non-blocking outbound HTTP for servers (NEW ask — the practical one)

`srv.run(on_event)` is a single-threaded event loop, and every `web::http_*` call BLOCKS it, so
one slow outbound request freezes every connected client:

- A **Nominatim** reverse-geocode (the name-proposal feature) held ALL WebSocket replies — in the
  two-tab test an open-route reply queued >10 s behind one lookup.
- A **match request** whose corridor comes back empty walks routing's widen-and-retry loop: up to
  3 Overpass fetches, each with Overpass's own `timeout:25` — worst case ~75 s of frozen loop,
  observed as alternating harness failures until the polls were budgeted for it.
- The `web` client (ureq) has **no request timeout by default** — a stalled socket parks the loop
  indefinitely. (Independent small ask: a timeout parameter or sane default on the blocking calls.)

**What to implement — the lib already contains the right shape.** The WebSocket client is
poll-based (`ws_handler` + `try_recv`); HTTP wants the same pair:

```loft
h = web::http_begin("GET", url, "", headers);   // returns immediately (worker thread native-side)
resp = web::http_poll(h);                        // null until done; then the HttpResponse
```

A server loop then interleaves `poll_event` with `http_poll` and nothing freezes. Coroutine-aware
HTTP would also work, but the poll-pair is the smallest step and matches the lib's existing design
language. (Blocking `http_get` etc. stay — they're right for scripts.)

**Meanwhile, routing's vendored `web` carries upstream candidates:** `http_get_file(url, path)`
(binary-safe download-to-file — `http_get`'s `into_string()` mangles PNG bodies; used for terrain
tiles) and the Part 2 #6 `text?` compile fix.

### 2. Offline Mode A — still Part 1, unchanged

The generic JS→loft input channel for `--html` (Part 1, Option A — the push/poll byte channel
BROWSER_INTEROP.md designs) remains the only thing between routing and an offline/no-server build.
Nothing new to add; it is now the LAST feature-shaped item on routing's list, so its priority from
this consumer's side went up.

### Not blockers (for completeness)

- ULP-level `tan`/`atan2` libm divergence between native and wasm targets (~1e-10 m on a
  geodesic) — a target fact, handled by a numeric parity gate; documented here so nobody chases
  it as a kernel bug.
- A touch lasso for multi-select is deferred product work, not a loft gap.

---

## 2026-07-03 — verified against HEAD `f845424d` (D-own-1 ownership DEFAULT-ON)

Routing re-verified in full against this morning's build — i.e. WITH the @PLN85 deps-driven
ownership fixes default-on: **26 kernel tests on interpret AND native, wasm parity, and all six
integration harnesses green, zero source changes needed.** A real multi-lib consumer (kernel +
server + web + imaging, Viterbi matcher, store, sync) passing under the flip is hopefully useful
evidence for D-own-1.

Bug scoreboard from the 2026-07-02 reports, re-run from the minimal repros:

| Report | Status at `f845424d` |
|---|---|
| constructed-text arg zeroes a `float?` return (native) | **FIXED** — min repro prints 42.5 |
| `text as integer` from a discharged local → E0605 (native) | **FIXED** — parses 4209 |
| parser ICE: float format precision 0 (`"{m:1.0}"`) | **still open** — same `collections.rs` unwrap panic |
| text tail-call with a heap-param callee → `Str::new(&Str)` E0308 (native) | **still open** |

Routing's workarounds for the two open ones stay load-bearing (`nice_length` rounds through an
integer; `area_name` binds-then-returns); the two fixed ones' workarounds are now optional (the
integer tile keys and inline parses stay — they're the better designs anyway).

Also: the 2026-07-02 21:51 build panicked at startup under a filesystem-restricted sandbox
(`store.rs:381 Opening file` on hello-world — it opened something the sandbox hid); today's build
doesn't. If that open is still unconditional-but-fallible somewhere, a graceful fallback would
make loft friendlier to sandboxed CI runners.

---

## 2026-07-03 (loft side) — both remaining blockers CLEARED + the ecosystem breakage fixed

Follow-up from the loft side; everything verified before writing.

**1. Non-blocking outbound HTTP — SHIPPED, engine-integrated (loft `tuxedo-work` `e93f5f62`).**
Not the poll-pair: the completion arrives as an ordinary engine event, so the loop
never blocks *or* polls:

```loft
id = engine_host::http_fetch("GET", url, "", "user-agent: routing/1.0");
// ... returns immediately; later, in on_event:
fn(ev: engine_host::Event) {
  if ev.kind == 3 {           // http completion
    // ev.cid == id, ev.status (negative = transport error), ev.payload = body
  }
}
```

Requests time out engine-side at 30 s (no knob — covers Overpass's `timeout:25`);
non-2xx is a completion (ev.status = the code), not an error.  The invariant is
test-pinned (`tests/engine_host_http.rs`): a 400 ms upstream while 2 ms ticks flow —
the ticks must keep advancing.  NOTE this is the ENGINE path (`engine_host::run`
loops); a standalone `web::http_begin`/`http_poll` pair for script-driven loops is
deliberately an **open design** still — if the `srv.run` shape works for routing's
server, no action needed.  Headers ride as newline-separated `Name: value` lines
(your Nominatim User-Agent goes there).

**2. web + server REPUBLISHED — your vendored patches can be dropped.**
`web 0.2.3` + `server 0.2.2` compile on current loft (`try_recv -> text?`,
`next -> text?`, malformed `msg_id` frames warn-and-drop).  Also: the registry's
`web 0.2.2` was a **phantom** (its tarball URL 404s — that's why your registry
fetch and the repo disagreed); the entry is removed from the signed index.
`loft install web@0.2.3` / `server@0.2.2` verified from a clean cache.
(Your `http_get_file` binary-safe download + blocking-call timeouts remain good
upstream candidates for the web lib — not yet picked up.)

**3. Part 1 / offline Mode A — already shipped before your 07-03 update.**
`host_input()` landed 2026-07-02 (loft #476): a `--html` host import + stdlib
`pub fn host_input() -> text`, exactly the Option-A byte channel.  Your
headless-Chromium parity harness is the acceptance gate still worth running.

**4. Doc gaps #1-#5 — done.**  `--help` documents `--html`; WASM.md now opens
with a three-worlds table (--html vs --native-wasm vs the IDE build, with your
size measurements) and scopes the Host Bridge API; HTML_EXPORT.md states its
import list is complete (no fs/args/env); BROWSER_INTEROP.md carries a
shipped/not-shipped STATUS banner; the web README marks `http_*` native-only
per function.  #7's auto-invalidation and #8 (loft#475) were already fixed.

**5. The `{m:1.0}` precision-0 ICE — fixed** (regression:
`tests/scripts/448-float-format-precision-zero.loft`); your `round(m) as integer`
workaround can stay or go.


---

## 2026-07-03 (loft side) — loft#488 ROOT-CAUSED + FIXED (pending merge)

The "context-dependence" was an illusion: `parse_return`'s buffer-delivery gate only fired when
the returned value's deps included an ARGUMENT — `return b.v` (field of param) delivered,
`return r.pts` (field of a LOCAL) never did, in any program. Native returned the empty DbRef
honestly; interpret only APPEARED correct (top-of-stack read off a freed record + a store leak).
Your passing reductions all returned field-of-argument or whole locals — that's why bottom-up
reduction couldn't corner it. Fixed on `tuxedo-work` `f7378b54` (gate now also fires for a dep on
a non-vector local; regression `450-struct-field-vector-return.loft`); verified against THIS
repo's real repro: `match_for` with the pre-workaround `return r.pts` delivers 20/20 points on
both backends and the live WS round-trip returns `5:387.7…|…` again. **After the next loft merge
the `&`-out-param workaround in `match_for` can be retired.** The return-shape differential
corpus suggestion is noted on the issue for @PLN85's return-machinery pass.

## 2026-07-03 — native: `return struct.field` (heap vector) DELIVERS EMPTY, context-dependent — FILED as loft#488

Fifth of the week, same return-position family, found live (the app drew no matched routes). In
the routing server, `match_for` ended with `return r.pts;` where `r` is a `MatchResult { pts:
vector<GeoPoint>, gaps: integer }` local — and the caller received an EMPTY vector. Proof it's
the return, not the compute: a `println` immediately before the return printed `pts=20 gaps=0`
while the wire reply carried the empty encoding. Interpret is fine.

**Context-dependent:** three standalone reductions (same corridor file, same trace, sliced-text
args, both backends) all pass — the corruption only manifests inside the full server program,
like the constructed-text/`float?` bug before its fix. So no minimal repro yet; the in-context
evidence is: loft HEAD `f845424d`+, `--native`, `server/server.loft` @ `match_for`, reply `5:0|`
with the debug print showing 20 points at the return site.

**Workaround (applied):** the `&`-out-param pattern — the caller owns the vector, the fn appends
element-by-element (`out += [r.pts[i] ?? …]`). That shape has been reliable all week.

**Meta-observation for @PLN85:** all five native bugs this week sit in RETURN-position machinery
around heap/wrapped values (float?-with-constructed-arg, E0605 parse temp, Str::new double-wrap,
and now a struct-field vector delivering empty). A poison-style differential corpus over "return
X" shapes (X = field/param/local/call, value = text/vector/struct/optional, arg mix constructed/
literal) × (small/large program context) would likely net the whole class.

**Consumer verification (routing side, 2026-07-03 13:0x).** Re-ran everything against
`../loft` `0e18de1d` (release build 12:48, @PLN85 ownership flip default-ON) and
`../loft2` `f7378b54`:

| Check | ../loft `0e18de1d` | ../loft2 `f7378b54` |
|---|---|---|
| loft#488 real repro (`match_for` with `return r.pts`, DIRECT probe) | len=0 (fix not merged — expected control) | **len=20 — FIXED** |
| precision-0 format `{m:1.0}` | prints `4` — **fixed** | prints `4` — **fixed** |
| text tail-call, heap-param callee (`Str::new(&Str)`) | E0308 — still open | E0308 — still open |
| full kernel suite (9 files, 31 tests, interpret + native) | **all green** | — |

The `&`-out-param workaround in `match_for` stays until f7378b54 reaches the `../loft`
checkout we build from; `area_name`'s bind-then-return stays load-bearing (tail-call E0308
open in both trees).

**Still-open problems on the routing side (same day, explicit list — the table above buries them):**

1. **Heap-param tail-call E0308 is STILL BITING** — not historical: the minimal repro
   (`pick`/`jtext`, this doc 2026-07-02) fails `--native` on BOTH `0e18de1d` and `f7378b54`
   today. `area_name`'s bind-then-return workaround remains load-bearing in production.
2. **loft#488's workaround is still in our tree** — the fix exists only on `tuxedo-work`;
   until it reaches the checkout we build from, `match_for` keeps the `&`-out-param shape.
   Please ping (or merge) when it lands so the natural `return r.pts` can come back.
   → **RESOLVED 2026-07-06** (see the section below): the fix reached the build we use and the
   workaround is gone — `match_for` now returns a `MatchResult`, so there is nothing left to retire.
3. **Open question we can't answer alone:** does `engine_host::http_fetch`'s event-delivery
   compose with the `server` lib's `srv.run` loop? Our server is srv.run-shaped; if http
   completions only arrive under `engine_host::run`, the non-blocking HTTP path stays unusable
   here and the `web::http_begin`/`http_poll` pair (marked "open design") becomes necessary
   after all.
4. **Every native build of our server prints two warts** (fresh 12:48 build, `srv_live15.log`):
   - `loft: warning — …/target/release/libloft.rlib is STALE (older than deps/libloft.rlib …)`
     on every run — if deps-first is always right, the bare-path rlib check reads like noise
     consumers can't act on (we must not `cargo build` in ../loft).
   - generated code carries a no-op `DbRef::NULL;` statement (`loft_native_*.rs:3837`,
     rustc `path_statements` warning) — harmless, but it means `-D warnings` consumers of
     generated output would break, and it hints at a dead value in the emit path.

---

## 2026-07-06 — loft#488 CLEARED on the routing side (fix reached our build; workaround gone)

loft#488 (native `return struct.field` for a heap vector → empty result) is resolved for routing on
two fronts, so still-open item 2 (2026-07-03 list) is closed:

- **The fix is in the build we use.** On `../loft` `loft 2026.7.1` the field-of-local heap-vector
  return delivers correctly on both backends. A direct probe — `return r.pts` where `r` is a local
  `struct { pts: vector<integer>, gaps: integer }` — prints `len=5` under both `--interpret` and
  `--native`; the same probe returned `len=0` on the unfixed `0e18de1d` build (see the table above).
  The 9-file / 31-test kernel suite is green on both backends.
- **The workaround is no longer in our tree.** `match_for`'s `&`-out-param shape is gone — routing's
  map-matcher was rewritten and `match_for` now returns a `MatchResult`, with callers destructuring
  `.pts` (`server/server.loft` `reply_match`, `reply_export`). Routing no longer emits the
  `return struct.field` pattern at all, so #488 cannot bite here regardless of the toolchain.

The remaining routing-side ask is the heap-param tail-call E0308 (still-open item 1) — a different
bug, unaffected by this; `area_name`'s bind-then-return workaround stays load-bearing.

---

## 2026-07-07 — debugger `--rpc`: `eval`/`setValue` return null in ANY frame that has a `vector` local

Trying out the `@PLN16` live debugger (`loft debug <file> --rpc`) on the map-matcher, `eval` and
`setValue` were unusable — `eval` returned `value:null` for **every** expression, including pure
literals like `2 + 2`, and `setValue` was `"edit rejected"`. Breakpoints, the `stopped` frame
(locals render inline), `stepOver`, and `continue` all work. Narrowed to a precise, minimal, **program-
independent** trigger.

Build: `../loft` `loft 2026.7.1`, branch `tuxedo-add-to-project` @ `dc06812a`. Breakpoints report
`verified:true` with absolute paths (so this is **not** the closed relative-path bug loft#342), and it
reproduces on both `--interpret` and `--native`.

### What we found (all verified, one `eval "2 + 2"` per row)

The ONLY thing that varies is what locals the paused `main` frame holds:

| frame contents at the breakpoint | `eval "2 + 2"` |
|---|---|
| scalars only (`x = 2 + 2`) | **`4`** ✓ |
| + a `use routing_kernel::(…)` import | `4` ✓ |
| + a second function in the file | `4` ✓ |
| + a **struct** local (`P { a, b }`, live) | `4` ✓ |
| + an integer `for`-loop accumulator (no vector) | `4` ✓ |
| **+ a `vector<integer>` literal (`[1,2,3]`)** | **`null`** ✗ |
| **+ a `vector` built by append (`v += [i]`), any length ≥ 1** | **`null`** ✗ |
| **+ a `vector` local that is DEAD at the breakpoint** | **`null`** ✗ |
| the real matcher (`ways`, `route`, … vector locals) | `null` ✗ |

So: **the mere presence of a `vector<T>` local in the frame's var-table makes `debug_eval` return
`null` for all expressions** — independent of the expression, of the vector's *liveness* at the
breakpoint line, and of its length. Structs and scalars in the frame are fine. `setValue` follows the
same split: it edits a scalar frame correctly (`setValue x = 42` → frame updates, and `continue`
prints `42`), but is `"edit rejected"` in a vector-local frame.

Frame *inspection* is unaffected — the `stopped` event still renders the vector inline
(`ways` and the `Graph` printed fine) — it is specifically the `debug_eval` / `debug_set` engine
methods that abort in a vector-local frame.

### Minimal repro

```loft
// prog.loft — delete the `v` line and `eval "2 + 2"` returns 4 instead of null
fn main() {
  v: vector<integer> = [1, 2, 3];
  x = 2 + 2;
  println("{x} {len(v)}");
}
```
```sh
printf '%s\n' \
  '{"id":1,"req":"launch","file":"/abs/prog.loft"}' \
  '{"id":2,"req":"setBreakpoints","file":"/abs/prog.loft","breakpoints":[{"line":3}]}' \
  '{"id":3,"req":"run"}' \
  '{"id":4,"req":"eval","expr":"2 + 2"}' \
  '{"id":5,"req":"disconnect"}' \
| loft debug /abs/prog.loft --rpc
# → {"id":4,"ok":true,"value":null}    (with the vector local)
# → {"id":4,"ok":true,"value":4}       (without it)
```

### Expected (PROTOCOL.md)

`eval` maps to `debug_eval` → `{ok, value, type}`; `setValue` maps to `debug_set` → `{ok, frame}`
("edits the live run"). Both are advertised from day one. Here they silently degrade to `value:null`
/ `"edit rejected"` whenever a `vector` slot is present — no error surfaced, just null.

### Why it matters

This is the difference between a usable and an unusable agent debugger. The loft-debug workflow leans
on exactly these two — "`eval` runs against the paused frame", "`setValue` edits the live run… inject
the suspect value instead of rebuilding". But essentially **every realistic loft function has a
`vector` local**, so in practice `eval`/`setValue` never work: on the map-matcher we could set
breakpoints and read the frame, but could not evaluate `len(route)` or inject a value. We fell back to
reading the whole `stopped` frame + `stepOver`.

### Guess at the mechanism (for the maintainer to confirm)

`debug_eval` likely builds its evaluation scope by walking the frame's var-table, and a `vector`-typed
slot (a store-backed growable collection) trips that walk — aborting the *whole* eval to `null` rather
than that one variable. That it fires even for a literal (`2 + 2`, which references no locals) and even
when the vector is dead points at scope construction, not value resolution; that structs pass but
vectors fail points at the vector slot's store/DbRef handling specifically. No open tracker issue
matches (`debug eval`, `debugger rpc`). Routing can't fix loft here (`../loft` is read-only for us) —
filing/looking is the maintainer's call.

## 2026-07-08 — codegen: "Incorrect loop finish" with many loops in one function

`client/basemap_view.loft` (store → text reader) panicked at runtime, **native and interpret**:

```
thread 'main' panicked at src/variables/mod.rs:623:9:
assertion `left == right` failed: Incorrect loop finish
  left: 18  right: 17
```

The `main` had ~9 `for` loops (five over the layout `PTile` layers + a nested three-deep walk over the
roads `TTile` steps). **Each block runs cleanly in isolation** — a minimal `main` with the areas loop,
another with the labels if/else loop, another with the roads triple-loop all pass; only the combined
`main` trips it. The `left/right` counts (`18`/`17`) point at loop-scope *bookkeeping* at codegen (an
off-by-one in the number of loop scopes opened vs. finished in one function body), not value resolution.

**Workaround (in place):** split each layer's emit into its own `fn` (`emit_areas`/`emit_buildings`/…/
`emit_roads`), so no single function holds more than 2–3 loops. Reproducible; `../loft` is read-only for
us, so filing/fixing is the maintainer's call.

## 2026-07-09 — store engine + web lib: loft-wasm needs a byte codec + a binary fetch to read a store in the browser

> **RESOLVED 2026-07-12 — loft shipped both.** The stdlib now has a heap store reader that runs in wasm
> (`store_load(r, path)`, doc: *"open a snapshot for querying where `store_persist_bind` can't run — a
> browser / wasm target"*) plus `store_load_url(r, url, sha256)` / `store_load_url_trusted(r, url)`, which
> fetch a store image over HTTP and decode it, "bytes never touch disk" (+ paged `store_load_key(s)` /
> `store_load_range`, loft#522). In wasm the fetch is bridged to JS `fetch()` via the asyncify host import,
> so `store_load_url_trusted` is identical native↔browser. **Both gaps below are gone; no `codec.loft`, no
> host_input byte-smuggling.** Verified here: `store_load` decodes the real 20.8 MB layout store byte-for-
> byte under `--native-wasm` (tiles 1089 / buildings 130402), and in **headless chromium** the
> `web_basemap_kernel.loft` page loads both stores by URL and runs `view <bbox>` + `match` (route
> byte-identical to native, ways=13077). See PLAN-BUILD B4/B5 and `browser/store-app.*`.

**Context.** Target architecture (PLAN-STORE / PLAN-BUILD): loft builds two binary stores — layout `PTile`
and roads `TTile` — with `store_persist_bind`, served static on GitHub Pages; the browser fetches them and
**loft-wasm** decodes them → emits the base-map `view` text + the matched `route` over the
`host_input`/`println` bridge → JS renders. B4 (compile `client/basemap_kernel.loft` with `loft --html`,
read the store in-browser) hits two gaps.

**Gap 1 — no wasm store reader (the codec).** `store_persist_bind`/`store_load` are the **mmap** store
(native). PLAN-APP §3 already says it: *"no mmap in wasm, so the tile format is read by explicit decode, not
`store_persist_bind`."* No such decoder exists (`codec.loft`, referenced in PLAN-BROWSER 8.3, is unbuilt).
`store_load` *compiles* under `loft --html` but is the mmap reader and can't load a store in wasm.
**Need:** a byte (de)serialization for `hash<T[key]>` that runs in wasm — encode native, decode in wasm →
the same `hash<TTile[tkey]>` / `hash<PTile[tkey]>`. Shared native+wasm so the round-trip is byte-verifiable
(PLAN-BROWSER 8.3 gate: loaded-store match == direct-ways match).

**Gap 2 — no wasm binary fetch.** `lib/web` in wasm gives only **text** HTTP: `http_get(url) -> {status,
body: text}` (its own comment: "mangles binary bodies like PNG"); the binary-safe `http_get_file(url,path)`
is `#native` (writes a file — no browser FS). So there is no wasm-safe way to pull binary store bytes into
loft. **Need:** a wasm binary GET returning bytes into loft (a byte buffer / `vector<u8>`), ideally with
**HTTP Range** so the later partial-read path works (PLAN-APP §3 step 2 / loft-libs-net #517). (`host_input`
can carry the bytes instead — JS fetches + feeds — but the codec of Gap 1 is still required to decode them.)

**What "works here" looks like.** loft-wasm: (fetch or receive) store bytes → **codec decode** →
`hash<TTile>`/`hash<PTile>` → the existing `view` (`basemap_kernel` `emit_*`) + `match`
(`tiles_corridor_ways` → `build_graph` → `match_route`), text out over `println`. Until then routing uses a
**text interim**: native loft projects the stores → view + roads text at build time, served on Pages;
loft-wasm matches from the roads text via `host_input` (the proven `web_kernel` path).

**Evidence.** `basemap_kernel.loft` (B3, native) verified `view` + `match` from the two stores; `loft --html`
compiled a `store_load` probe (399 KB html / 298 KB wasm) — but that's the mmap reader; `lib/web`'s wasm HTTP
is text-only. `../loft` is read-only for us — the codec + binary fetch are the maintainer's to build ("we'll
build something that works here").

## 2026-07-15 — loft 2026.7.1 resolution: `use <submodule>;` no longer reaches a package submodule from a test file

**Context.** loft `2026.7.1` (installed 2026-07-15; it ships @PLN106 `--native-android` and the @PLN107
dead-store lint DEFAULT-ON — `LOFT_NO_DEAD_STORES` opts out — both validated here while cutting
`graphics 0.4.2`) tightened library/submodule resolution.

**What we found (verified, both backends).** In `loft-libs-graphics` the package entry is `src/graphics.loft`,
with sibling submodules `src/{math,mesh,scene,render,glb}.loft`. Two resolution facts now disagree:

- **From inside the package it still works.** `src/graphics.loft` itself does `use math; use mesh; use scene;
  use glb;` and compiles fine — so every `use graphics;` consumer is green (verified: `ssh_home` +
  `tests/canvas.loft` pass 30/30 on `--interpret` and `--native`).
- **From a sibling test file it no longer works.** A module test that does `use math;` to exercise the
  submodule directly fails to resolve the submodule's own `pub` functions:
  ```
  Error: Unknown function vec3        at tests/math.loft:7:34
  Error: Unknown function dot3        at tests/math.loft:25:31
  Error: Unknown function normalize3  at tests/math.loft:41:29
  FAIL  tests/math.loft  (parse errors)
  ```
  And the qualified form does not reach it either:
  ```
  Error: Name 'math' not found in library   at tests/math.loft:6:3    (with `use graphics::math;`)
  ```

**Impact.** graphics' four module-level tests — `tests/{math,mesh,scene,scene_glb}.loft` — all fail
(`5 failed; 34 passed`); only the `use graphics;` tests (canvas, text_height, kerning, font_ascent,
input_events) pass. **Pre-existing** — it fails identically on the committed `0.4.1` HEAD, i.e. it is the
toolchain upgrade, not the lib. `graphics 0.4.2` shipped with these four tests red on purpose (orthogonal to
the warning cleanup; called out in the release commit).

**The asymmetry is the bug.** A package submodule is importable by bare name *from within the package* but not
*from a sibling test dir*, and there is **no qualified form** that reaches it (`graphics::math` → "not found").
So a package submodule is currently **un-unit-testable in isolation**. Either the test-context submodule
resolution regressed, or bare-submodule import is being retired — in which case the entry's own `use math;`
should break the same way (it does not — that is the asymmetry), and there needs to be a sanctioned way to
reach `math::vec3` from a test (a working `use graphics::math;`, or a `pub use` re-export). `../loft` is
read-only for us — filing/fixing is the maintainer's call.

## 2026-07-15 — @PLN25 DN1 diagnostic: the nullable-return warning anchors at the *next* function, not the culprit

Under DN1, storing a `τ?` (from a fallible `/`, `sqrt`, or a parse) into a non-null return warns:
```
warning: a nullable `integer?` is stored into element 0 of the return value of the
non-null type `integer` — it becomes null there; discharge with `?? <default>` …
```
The rule itself is landing cleanly and is ergonomically bearable — a single `?? <default>` at the return site
discharges it (matches the C80 spreadsheet model). **But the source span points at the wrong function** —
consistently the *declaration line of the function AFTER* the one that actually returns the nullable value.
Two independent instances, same session:

| culprit (returns a fallible expr into a non-null type) | warning anchored at |
|---|---|
| `ssh_home` `grid_cols_rows` → `(integer, integer)` from a guarded `win_w / cell_w` (`main.loft:120`) | `default_font_size` (`main.loft:129`, the *next* fn) |
| `graphics` `length3` → `sqrt(sum-of-squares)` = `float?` (`math.loft:67`) | `normalize3` (`math.loft:71`, the *next* fn — which is already `??`-discharged) |

So the caret sends you to a function that is *fine* (often already discharged), and you locate the real site by
elimination (which fn returns a fallible expression into a non-null type). Minor but repeatable — the span
should anchor on the offending `return`/tail expression, or at least on the culprit function's own header. It
slightly raises the DN1 discharge cost: the first look lands on the wrong line. Both sites were fixed here with
`?? 0` / `?? 0.0`; `../loft` is read-only for us — reported for the maintainer.

## 2026-07-16 — `loft --native`: a `#native` package's symbols "not registered" though its `loft_register!` is correct (P269)

**Context.** `ssh_home` Step 4 wires the published `ssh 0.1.0` lib (`loft-libs-net`, russh FFI) into a live
transport test. It works end-to-end under `--interpret` (see below), but **fails to compile under
`loft --native`**:

```
error: loft --native: native fn `n_ssh_recv` (#native "n_ssh_recv") has no implementation in any registered
       native crate; either run via --interpret or wire the symbol in a #native package or
       src/codegen_runtime.rs (P269)
```
— the same for `n_byte_at` and the other `n_ssh_*` (5 errors total).

**The registration is correct.** The ssh native crate's build.rs runs
`loft_ffi_build::generate_register_from_loft_with_bridges("../src")`, and the generated
`OUT_DIR/loft_register_gen.rs` is complete and well-formed — all nine functions plus their bridges:
```
loft_ffi::loft_register! { n_byte_at, n_ssh_close, n_ssh_connect, n_ssh_is_open, n_ssh_login,
                           n_ssh_open_shell, n_ssh_recv, n_ssh_resize, n_ssh_send, }
loft_ffi::loft_register_bridges! { "n_byte_at" => n_byte_at__loft_bridge, … }
```
(pulled into `native/src/lib.rs` via `include!(concat!(env!("OUT_DIR"), "/loft_register_gen.rs"))`).

**The contrast that localises it.** In the SAME project, `graphics 0.4.2` — whose native crate declares an
equivalent `loft_register!` / `loft_register_bridges!` (hand-written in `lib.rs` rather than `include!`d) —
**links fine under `--native`** (all the `vttest*` model tests run `--native`). And the ssh lib itself was
*"interpret + native + live-sshd all green"* under an **earlier** loft. So this is a **loft 2026.7.1 `--native`
regression** in discovering / linking a `#native` package's registration, **not** an ssh-lib or ssh_home
defect — the generated registration is byte-correct. The one visible difference to probe: graphics registers
directly in `lib.rs`; ssh registers via `include!(OUT_DIR/loft_register_gen.rs)` — if `--native`'s crate/symbol
discovery no longer sees an `include!`d `loft_register!`, that would explain the asymmetry (the interpreter
cdylib path finds it either way; only the `--native` rlib-link path regressed).

**What works (so the transport itself is proven).** Under `--interpret`, the full live smoke against a
throwaway paramiko sshd (real bash PTY) passes: connect, password auth **and** rejection, a real shell,
`echo LOFT_OK` round-trip, a **binary** round-trip (raw `ESC` 0x1B survives the FFI, checked via `byte_at`),
and resize propagation (`stty size` reports the resized dims).

**Impact / ask.** `ssh_home` is a `--native` app, so this blocks its Step 5 integration. `../loft` is
read-only for us. Likely fixes for the maintainer: restore `--native` discovery of an `include!`d
`loft_register!`, or (ssh-lib side) hand-write the register block into `lib.rs` like graphics + republish
`ssh 0.1.1` rebuilt under 2026.7.1 — but that only helps if the root cause is the `include!`, which is the
maintainer's to confirm.

> **ROOT-CAUSED + FIXED upstream 2026-07-16 (my `include!` guess was wrong).** The loft agent hit the same
> failure and fixed it on `../loft` `tuxedo-consumer-nullflow-fixes` (commit `917da317`, not yet merged): a
> **`loft install <dir>` copied only `src/*.loft` + `loft.toml` and DROPPED the `#native` crate (`native/`)**,
> so the `n_*` symbols were undefined at `--native`/`--native-android` link time — a local-vs-registry
> asymmetry (`loft package`/the registry path already carried `native/`). `install_package` now recursively
> copies `native/` (excluding `target/`+dot-dirs), and it's **verified end-to-end specifically with `ssh`
> (russh/ring FFI): local-installed `ssh` now cross-compiles + links via `--native-android`**. So this is a
> toolchain/packaging bug, not `include!` discovery. **Action here:** once that branch lands and `loft` is
> reinstalled, re-run `loft --native tools/ssh_smoke.loft` — it should pass and unblock ssh_home Step 5.
>
> **✅ VERIFIED RESOLVED 2026-07-16.** The local `loft` was rebuilt (still `2026.7.1`, binary+runtime dated
> 2026-07-16 11:56) carrying this fix (and the `@PLN102` domain lattice — `LOFT_NO_MATH_DOMAIN`). After a fresh
> `loft install ssh@0.1.0 --refresh`, **`loft --native tools/ssh_smoke.loft` now PASSES the full smoke** —
> auth accept+reject, shell, binary ESC round-trip, resize — so ssh_home Step 5 is unblocked. No P269. Whole
> issue closed.

---

## 2026-07-16 — `@PLN40` const fields: a const field READ on the RHS of an element-store is rejected as a "reassignment"

**Context.** `@PLN40` (const struct fields, `4067eb52`, now the HEAD of loft `origin/main`) landed today, and
routing swept `const` across its six vendored libraries to dogfood it. The sweep does not compile — and the
two failures below are why the sweep had to be **substantially rolled back** (see *Impact*).

**Defect 1 — a READ is flagged as a reassignment (false positive).** Reading a struct field on the
right-hand side of a **vector element-store** is rejected, though a read reassigns nothing:

```loft
struct E { const length: float }
fn main() {
  e = E { length: 4.0 };
  cm = [0.0];
  cm[0] = (cm[0] ?? 0.0) + e.length;   // error: cannot reassign const field 'length' of struct 'E'
}
```

The identical expression on the RHS of a **plain** assign (`x = x + e.length`) is fine. So the trigger is
the *element-store target*, not the read.

**Defect 2 — the trigger is the STRUCT, not the field (this is the severe one).** The field actually read
does not need to be const. Any struct carrying **≥1 const field** cannot have **ANY** of its fields read on
the RHS of an element-store:

```loft
struct E { const zzz_first: integer, bbb_second: float }   // only zzz_first is const
…
cm[0] = (cm[0] ?? 0.0) + e.bbb_second;   // reads the NON-const field
// error: cannot reassign const field 'zzz_first' of struct 'E'
```

Note the diagnostic names **`zzz_first`** — a field the statement never mentions. It appears to report the
struct's **first** const field rather than the one referenced, which sends you looking at the wrong line
(in routing it named `GEdge.a` while pointing at a column holding `e.b`).

**Boundary matrix** (loft `origin/main` `4067eb52`; identical on `--interpret` and `--native`):

| shape | verdict |
|---|---|
| `s.v += [x]` where `const v: vector<T>` | rejected — see the spec question below |
| `s.v[0] = x` where `const v: vector<T>` | ok (matches LOFT.md: contents allowed) |
| `vec[s.cf] = x` — const read as **index on the LHS** | ok |
| `vec[i] = … + s.cf` — const read on the **RHS** | **REJECTED — defect 1** |
| `x = x + s.cf` — same read, **plain** assign | ok |
| `vec[i] = … + s.NONCONST` where the struct has any const field | **REJECTED — defect 2** |
| `t = s.cf;` then `vec[i] = … + t` | ok — **workaround** (hoist to a local) |
| *control:* same code, struct has **zero** const fields | ok — proves `const` is the trigger |

The control is the point: adding a single `const` anywhere in a struct breaks every element-store that
reads that struct, including reads of its non-const fields.

**Spec question (not a bug) — is `+=` on a const collection field a rebind?** LOFT.md § Fields says const
"freezes the field *binding*, not its contents: `const v: vector<T>` rejects `t.v = […]` but still allows
`t.v[0] = x`." `+=` is a compound assign, so it is a rebind and is rejected. That is self-consistent, but it
means **any `+=`-grown collection field can never be const** — which in routing is most of them
(`EdgeCosts`'s 5 parallel arrays, `PTile`'s 5 geometry vectors, `TTile.roads/steps`, `Image.data`). If
"append" is meant to be a contents mutation rather than a rebind, that is a language-definition decision
worth making explicitly; today the ergonomics push `const` off exactly the set-once-then-grown fields where
it would document the most.

**Impact here.** Routing's sweep keeps `const` only on pure value structs (`GeoPoint`, `BBox`, `Coord`,
`Way`, `Request`, `HttpResponse`, `WsEvent`, …). Rolled back to plain fields:
- `GEdge` — set-once at build, never mutated, but `to[pa] = e.b` (`build_adj`) and `cm[c] = … + e.length`
  (`match_quality`) trip defect 2. This is the hot path; the workaround (hoisting each read to a local)
  would add noise to the inner loop to satisfy a false positive, so the struct stays plain.
- `SubPath` — same shape via `cm[c] = (cm[c] ?? 0.0) + (s.class_m[c] ?? 0.0)`.
- `EdgeCosts` / `PTile.areas…` / `TTile.roads/steps` / `Image.data` — the `+=` spec question above.

Both are marked in-source with a pointer back here, so the `const` can be restored once defect 2 is fixed.

**Verified.** With defects 1–2 worked around, the full routing suite is green on `origin/main`'s loft —
kernel 39 tests (geodesic/corridor/gpx/import/loop/matcher/profiles/roundtrip/elevation) plus imaging/web,
on **both** `--interpret` and `--native`.

**Toolchain note.** The installed `/usr/local/bin/loft` was **reinstalled at 16:58 local while this was
being written** and now carries `@PLN40`; the earlier build (09:56 UTC, predating the 11:57 UTC merge)
rejected `const` outright with "const struct fields are not yet supported (planned — @PLAN33)". Every cell
of the matrix above was **re-probed on the fresh installed binary and reproduces identically** — so this is
a live defect, not an artifact of a stale toolchain. (Worth noting for the next reader: loft is a moving
target here, and a matrix probed against one binary can be invalidated by a reinstall mid-session.)

**Ask.** Fix defect 2 (and with it defect 1): a field **read** should never be treated as a write,
whatever the enclosing statement's assignment target is; and the diagnostic should name the field actually
referenced, not the struct's first const field. Until then `const` is unusable on any struct that feeds a
vector element-store, which in array-of-struct code (the whole routing kernel) is most of them.

---

## 2026-07-16 — the null-flow lint (@PLN102/DN1): inverted polarity, plus two hazards found discharging it

Discharging routing's 26 null-flow warnings surfaced three separate things. The discharge itself went
fine — the idiom from `4f66f60` (`?? <default>` at a site the surrounding code already bounds, with the
bound written down) scaled to all 26, and every value is byte-identical before/after on interpret and
native. These are what the exercise *found*.

### 1. The lint warns on correct code and stays silent on the broken case (for-range bound-carry)

`v[i]` bound-carry (@PLN102 D1) suppresses the warning whenever `i` is a **for-range variable**, without
checking that the vector indexed is the one the range came from. Identical bug, opposite diagnosis:

```loft
v: vector<P> = [ … 3 elements … ];
w: vector<P> = [ … 1 element  … ];      // SHORTER
for i in 0..len(v) { s = s + take(w[i]); }   // 0 warnings — runtime: s = null
i = 0;
while i < len(v) { s = s + take(w[i]); i = i + 1; }   // 1 warning — runtime: s = null
```

Both silently produce `s = null`. Only the `while` form is flagged. Meanwhile every site the lint DID
flag in routing's kernel was provably in range (a loop condition, an early return, a `len()` check).

So the polarity is inverted where it matters: false positives on correct code, a false negative on the
genuine out-of-bounds read — and, worse, the shortest way to silence a warning is to rewrite the `while`
as a `for`, which removes the diagnostic while *preserving* the bug. We deliberately did **not** do that
in routing; the discharges name their bound instead.

> **Root cause located by the maintainer's triage (2026-07-16):** `Parser::index_provably_fit`,
> `src/parser/fields.rs:774` — the `Value::Var` arm returns `true` for *any* `is_active_loop_var`, with no
> check that the loop's range source is the vector being indexed. The neighbouring `if idx < len(vec)`
> guard path already does it correctly, pairing the index var with the vector's `VecKey` via
> `self.index_bounded`; the loop-var path needs the same pairing. Confirms the guess in this entry's last
> line — the carry should hold only when the range's source *is* the indexed vector.

Coverage probed (all with `for i in 0..…`): `v[i]` ✓ carried, `v[i-1]`/`v[i+1]` under `0..len(v)-1` ✓,
`v[2*i]`/`v[2*i+1]` under `0..len(v)/2` ✓, `for i in 0..n` with a local `n` ✓ (carries regardless of
what `n` is), reverse `v[len(v)-1-i]` ✗ (warns).

### 2. A struct CONSTANT as a `??` fallback miscompiles under `--native` (interpret/native divergence)

```loft
struct P { lat: float, lon: float }
NOWHERE = P { lat: 0.0, lon: 0.0 };     // top-level struct constant
…
take(v[0] ?? NOWHERE)
```
`--native` fails to compile: `error[E0308]: 'if' and 'else' have incompatible types … expected 'DbRef',
found '()'`. An **inline struct literal** (`?? P { lat: 0.0, lon: 0.0 }`) and a **zero-arg fn**
(`?? point_none()`) both compile and run identically on both backends.

> **Correction (2026-07-16, after the maintainer's triage — my first write-up understated this).** I
> reported the interpreter as merely *accepting* the form. It does worse: **the fallback never
> materialises and the expression evaluates to `null`.** My probe only ever exercised the non-null path
> (`v[0] ?? CONST`), so I never saw it. With the fallback actually taken:
> ```loft
> NOWHERE = P { lat: 42.0, lon: 99.0 };
> miss = v[5] ?? NOWHERE;      // --interpret: miss is NULL, not 42.0
> ```
> So both backends are broken and only native is loud: interpret yields a **silent wrong value** while the
> suite goes green; native fails the build. That inverts the severity — this is the more dangerous half,
> not the divergence. Verified the shipped fix is unaffected: `?? point_none()` and `?? P{…}` both return
> the fallback's fields when taken, on interpret AND native.

This bit exactly once: the interpreter suite was green while `make test`/`make test-native` failed with 17
E0308s. routing now spells the sentinel as `fn point_none() -> GeoPoint`, noted in-source. Repro is 7 lines.

### 3. `v[-1]` returns the LAST element — but the scalar-index contract says "null if out of bounds"

```loft
v: vector<P> = [P{lat:1.0,…}, P{lat:9.0,…}];
n = -1;
x = v[n];      // x.lat == 9.0  — the LAST element, NOT null
m = 99;
y = v[m];      // null, as documented
```

LOFT.md § Vectors documents scalar indexing as `v[i] // index (null if out of bounds)`, and `-1` is out
of bounds under any reading of that. Negative-counts-from-the-end is documented (@P384, INCONSISTENCIES
§ 28) **only for slices** — `v[2..-1]`, `v[-2..]` — not for scalar `v[i]`. So the index silently adopts
the slice convention, asymmetrically: **high** OOB → null, **negative** OOB → wraps to a real element.

The hazard is that this defeats the guard the lint itself recommends. `x = v[i]; if x { … }` reads as
"skip the out-of-range case", and it does — for `i >= len`, not for `i < 0`, where it happily hands you
the wrong element. Found it while trying to simplify `if ei >= 0 { e = g.edges[ei]; … }` (ei is -1 for
"no edge") down to a null guard: that refactor looks obviously equivalent and is silently wrong —
`g.edges[-1]` is the last edge, so the report would have attributed a real edge to a non-existent one.
The `ei >= 0` test is kept, with a comment saying why it is not redundant.

> **Resolved by the maintainer's triage (2026-07-16): INTENTIONAL, a doc gap — not a bug.** Scalar
> negative indexing is the deliberate Python-style last-element idiom, backend-identical, mirroring the
> negative *slice* bounds at LOFT.md:1269 (@P384). The full contract, which I verified independently on
> both backends (`v = [10,20,30]`):
>
> | index | `v[0]` | `v[2]` | `v[3]` | `v[-1]` | `v[-3]` | `v[-4]` |
> |---|---|---|---|---|---|---|
> | result | 10 | 30 | **null** | **30** | **10** | **null** |
>
> i.e. `i ∈ [0,len)` → element · `i ≥ len` → null · `i ∈ [-len,-1]` → element from the end · `i < -len` →
> null. So the ask is documentation only: LOFT.md § Vectors says `v[i] // index (null if out of bounds)`,
> which describes just the first two columns. The footgun below stands regardless of intent — `if v[i] {…}`
> does not guard a negative index — so the routing comment at the `ei >= 0` site stays either way.

### Verified

Kernel null-flow warnings 26 → 0, and 0 across the whole tree (kernel/imaging/web suites). All three
gates green: `make test` (ALL OFFLINE GATES PASS), `make test-native` (NATIVE KERNEL SUITE PASSES),
`make test-wasm` (interpret == native == native-wasm byte-identical; geodesic 1113.194907792064 m).
Value-parity checked directly against the pre-change kernel over 30 high-precision values (bounds /
corridor_margin / tile_xf / tile_yf / tile_key incl. extreme latitudes / path_length_m / is_loop /
clean_track / douglas_peucker / retrace_m): **byte-identical** old-vs-new on interpret AND native.

---

## 2026-07-16 (18:54 build) — REGRESSION: the "nullable → non-null PARAMETER" warning no longer fires

Re-tested routing against the freshly installed loft (18:54, built from `loft2` `tuxedo-work` @ `8118ab16`),
which carries the fixes for all three findings above. Two of the three land well; the third is defeated by
a separate regression in the same build.

### ✅ f2 (struct-valued constant) — fixed, and the diagnostic is exemplary

```
error: a struct-valued constant ('NOWHERE') is not supported — a record cannot be materialised at each
use site (it reads `null` on --interpret and fails to compile on --native).  Wrap it in a zero-argument
function instead: `fn nowhere() -> P { … }`, then call `nowhere()`
```
It names the failure on BOTH backends and prescribes exactly the workaround routing shipped. The fn form
and the inline-literal form both still return the fallback's fields when taken, on interpret and native.

### ✅ @PLN40 const model — fully fixed (`4f810080`)

All 8 cells of the const boundary matrix from the entry above now pass, including the two that forced
routing's rollback: `s.v += [x]` on a `const` collection field is accepted (append is contents, not a
rebind), and the RHS-read false positive is gone (`vec[i] = … + s.field` where the struct carries a const
field). **Routing's reverted `const` is now restored** — on `GEdge`, `SubPath`, `EdgeCosts`,
`TTile.roads/steps`, `PTile`'s geometry vectors and `Image.data`, plus `TileHeights.heights`,
`Server.handle` and `WebSocket.ws_id`, which the original sweep had left out for the same `+=` reason.
34 of routing's 40 lib structs are now fully const; the remaining 6 are genuine (`Graph` rebinds
`adj_head`/`adj_to`/`adj_edge` wholesale in `build_adj`; `Heap`/`Scratch` are mutable-by-design).
Value-identical on both backends; all four gates green.

### ⚠️ f1 (index-fit carry) — the fix is correct, but a regression hides its effect

The fix itself works: their guard case errors as designed, because the nullable propagates into a local
whose type would change.
```loft
fn f(v: vector<integer>, w: vector<integer>) -> integer { s = 0; for i in 0..len(v) { s = s + w[i]; } s }
// error: Variable 's' cannot change type from integer to integer?   ← the fix, working
```
But routing's ORIGINAL repro (`sound.loft`) is **still completely silent** — 0 warnings, `s = null` at
runtime — because it routes the nullable through a **non-null parameter** instead of a type-changing local:
```loft
fn f(v: vector<integer>, w: vector<integer>) -> integer { s = 0; for i in 0..len(v) { s = s + take(w[i]); } s }
// take(a: integer) returns integer, so `s` never changes type — and NOTHING is reported.
```

### The regression: the parameter class of the null-flow warning is gone

Not an indexing issue — it is the whole warning class. Same `float?` source (`1.0 / n`, no `v[i]` anywhere),
three destinations:

| destination | 16:58 build | 18:54 build |
|---|---|---|
| non-null **return value** | warns | **warns** ✓ |
| non-null **field** | warns | **warns** ✓ |
| non-null **parameter** | warns | **SILENT** ✗ |

```loft
fn takes(a: float) -> float { a }
fn par(n: float) -> float { x = 1.0 / n; takes(x) }   // float? -> non-null param: NO warning
```
Confirmed identical on the installed 18:54 binary and on `loft2/target/release/loft`. This is a regression,
not a softening we asked for: the 16:58 build warned on exactly this shape — routing's own kernel reported
`a nullable float? is stored into parameter 1 of 'sqrt'` and `... parameter 2 of 'geodesic_m'`. Measured on
the SAME unmodified pre-fix kernel source: **26 warnings on 16:58 → 5 on 18:54**, and all 21 that vanished
are the `parameter N of F` class; the 5 survivors are exactly the `field` (3) and `return value` (2) ones.

**Why this matters for "stable".** Passing `v[i]` (or any fallible-arithmetic result) straight to a function
is the most common shape in real loft code — it was 21 of routing's 26 sites. With that class silent, the
f1 fix cannot be observed through a call, and an out-of-bounds read silently yields `null` with no
diagnostic on either backend. It also means a consumer that discharges to zero warnings today (as routing
now does) is no longer evidence of much: routing's 0 would be 0 either way.

Suggested guard, since this class had no regression test: the three-destination probe above (return /
field / parameter from one `float?` source) as a warning-count test — it is four lines and would have
caught this.

---

## 2026-07-17 — @PLN105 `expose`/`deliver`: a store you expose becomes unreadable, and a top-level `hash` is not deliverable

> **§ 1 CONFIRMED on 2026.7.2, and narrowed — see *"`expose` UN-RETRACTED"* (2026-07-22) at the end of this
> file.** It is **iteration** that claims, not reading: `len`, point lookups and field reads all work on an
> exposed store. `release(tag, value)` restores iteration, which is the workaround this entry lacked. The
> "unreadable" phrasing below is too broad; everything else in § 1 holds.
>
> **§ 2 is SUPERSEDED** — `deliver` of a hash does fail, but `expose` does not go near that path
> (`collect_keyed` pre-flattens it). See the RETRACTED entry below. The per-tile fallback § 2 proposes is
> therefore unnecessary; step 9 exposes the whole layout hash.

**Context.** PLAN-PERF §0 step 9 hands the browser the layout store so JS reads PTiles from wasm memory
instead of loft serializing ~4.2 MB of text per pan (`view` = 29k lines the JS side then re-parses).
`BROWSER_INTEROP.md` § *The binary bridge* names routing's base-map `view` as the motivating consumer, so
this is that consumer trying it. Both findings reproduce on `--interpret` and `--native`.

### 1. `expose(tag, value)` pins the store read-only — and then loft cannot read it either

```loft
layout: hash<PTile[tkey]> = [];
store_load(layout, path);
for t in layout { n0 += 1; }          // fine — 1089 tiles
expose(1, layout);                     // returns; the host import fires with a valid handle
for t in layout { n1 += 1; }          // PANIC
```
```
thread panicked at src/store.rs:647:9:
Claim on read-only store (size=546) (locked by: lock_store(store_nr=1, rec=1))
```

The expose itself works — the host receives a usable handle (`tag=1 storeBase=29126376 rec=1 pos=8
typeId=135 descLen=1955`, a 1955-byte descriptor). But the read-only pin means **any later operation that
CLAIMS in that store panics**, and iterating a keyed collection claims (the scratch array the docs
describe). In the browser this manifests as a hang, not a panic: the kernel dies mid-command, never emits
its terminator, and the page waits forever.

**Why this bites the intended use.** The doc's model is *"pins the value's store … read it each frame"* —
i.e. expose once, then keep running. But a consumer that exposes a store it still uses (here: `view` reads
the same layout to emit its text) is dead on the next read. It also blocks the *safe* migration order —
land the JS reader **beside** the existing text path and compare, then delete the text path — because
during that overlap loft must still read what it has exposed.

**Ask:** either a read of a pinned store should not claim (a read-only iteration shouldn't need scratch),
or `expose` should be documented as *"loft must not touch this store again until `release`"* — currently
neither the stdlib comment nor BROWSER_INTEROP says so, and the failure is a panic/hang far from the call.

### 2. A top-level `hash<T[k]>` is not deliverable — including as a struct field

```loft
deliver(1, layout);        // hash<PTile[tkey]>
→ error=type 86 (hash<PTile[tkey]>) is a store-internal kind — not in the serializable subset
                            (cursor-walked in a later phase)
```
Wrapping it does not help — `struct LayoutRoot { tiles: hash<PTile[tkey]> }` + `deliver(1, root)` reports
the same, still naming the hash (type 87). `deliver` does NOT pin, so reads keep working — it is only the
container that is refused.

This reads as a doc/shipped-scope mismatch. BROWSER_INTEROP § *The binary bridge* says keyed collections
are **PRE-FLATTENED, not cursor-walked** ("at deliver time loft materialises it to a scratch array
(key-ordered) … the descriptor adds a `flat` redirect map"), which sounds shipped; the runtime says
cursor-walking is "a later phase". One of the two is describing a phase that is not in the installed loft.

**What DOES work, and is the way forward here:** an individual record delivers fine —
`deliver(1, t)` for a `PTile` (a struct of `text` + `vector<record>`) returns a proper handle and bytes.
So routing will deliver the viewport's tiles **one at a time** rather than the store: the view already
knows which tiles hit the bbox, so this is a handful per pan, not 1089. Recorded in PLAN-PERF §0 step 9.

**Impact.** Not blocking — the per-tile route avoids both findings (no pin, no keyed container). But the
documented "expose the store, read it each frame" shape is not usable by a consumer that still reads that
store, and the pre-flattened-keyed-collections paragraph does not match the installed runtime.

---

## 2026-07-17 — a call with TOO FEW ARGUMENTS is accepted, and silently corrupts the earlier arguments

**MINIMISED.** The SIGSEGV I first reported was my own bug — three missed call sites — but what loft did
with it is the finding: **there is no arity check**, and a missing *function-typed* argument corrupts the
arguments before it.

```loft
struct P { lat: float, lon: float }
fn sink(i: integer, p: vector<P>) { }
fn five(a: integer, b: vector<P>, c: text, d: boolean, cb: fn(integer, vector<P>)) -> integer { len(b) }
fn main() {
  n = five(1, [P{lat:1.0,lon:2.0}], "x", true);   // ← 4 args for a 5-param fn. Accepted.
  println("returned {n}");                         // prints 0.  len(b) of a 1-element vector is 1.
}
```

| the call | missing param's type | result |
|---|---|---|
| `five(1, [one elem], "x", true)` | `cb: fn(integer, vector<P>)` | **`returned 0`** — `len(b)` is wrong; `b` is corrupted |
| same, with the 5th param an `integer` | `e: integer` | `returned 1` — correct |

So: (a) too few arguments is not diagnosed at all, on either shape; (b) when the omitted parameter is
**fn-typed**, the *preceding* arguments are corrupted rather than merely the missing one defaulted.

**How it presented in real code.** Adding `on_stretch: fn(integer, vector<GeoPoint>)` to the matcher's
`build_state` while three of its five call sites still passed four arguments gave:
```
=== loft crash (loft) SIGSEGV caught ===
  last op:  (opcode dispatch) (op=193)
  at:      /usr/local/share/loft/default/01_code.loft:950:22    ← inside `pub fn len(both: vector)`
```
A segfault in the stdlib's `len`, naming no user line — from a wrong call several frames away. The
corrupted `b` above is the same fault, caught before it reached a bad pointer.

**Ruled out on the way** (all pass, so none is the trigger): a named fn-ref into a `fn(...)` param
(scalars or `vector<struct>`); an inline lambda; the param passed THROUGH a call and fired in a loop;
under `--tests` as well as `--interpret`; across a library boundary; the fn param at positions 1–5;
appending a struct then passing its field to the callback. The mechanism is sound — only the arity hole
is not.

**Ask.** Reject a call whose argument count does not match the declaration, at parse time. That is the
whole fix: the arity is known statically, the check is cheap, and it converts a stdlib segfault (or a
silently wrong `len`) into the one-line error the consumer actually needs. The corruption of *earlier*
arguments when the missing one is fn-typed is worth a look in its own right — a missing argument should
not be able to reach back over the ones that were supplied.

**A doc bug found alongside (independent, confirmed).** `loft-write` documents a named function reference
as `map(nums, fn double)` — with the `fn` prefix. The parser rejects exactly that:
> `error: Use the function name directly, without 'fn' prefix`

The working form is the bare name (`run(sink)`). The skill's *Higher-order functions* example should drop
the prefix; it is the first thing a consumer copies.

---

## 2026-07-17 — `par` rejects a captured reference (workable: put the data in the ELEMENT) — DOC gap

**Corrected 2026-07-17 (my first read of this was wrong — the maintainer's).** A `par` worker may not read
a captured **reference**, only scalars. I concluded the workload was inexpressible. It is not: *"only the
loop element may be a reference"* is the way through — **put the data in the ELEMENT**, i.e. make each job
self-contained with the slice that job needs, which is the ordinary data-parallel decomposition. Measured,
it works and it scales:

| slice each job carries | sequential | `par(…, 8)` | |
|---|---|---|---|
| 100 | 96 ms | **26 ms** | **3.7×** |
| 1000 | 88 ms | **22 ms** | **4.0×** |
| 10000 | 69 ms | 42 ms | 1.6× — the per-element copy eats the win |

Results identical in every case. So the real rule is a **design constraint, not a blocker**: give a worker
what its part needs, not the world — and keep the slice small, because the element is copied into the
worker's isolated store clone.

**What remains a genuine ask** is only the ergonomics for a *large shared read-only* input (a 13k-way
graph every worker reads). Slicing it per job is real work and may duplicate data; letting a worker read a
captured reference that is provably not written during the loop would avoid both. But that is an
optimisation, not a precondition — the workload IS expressible today.

```loft
struct Node { x: float, y: float }
struct Big  { nodes: vector<Node> }
fn work(i: integer, b: Big) -> float { … reads b.nodes … }
…
for i in 0..64 par(r = work(i, b), 8) { … }
```
```
error: par worker 'work': captured argument 'b' is a reference (Big); a par worker runs on an isolated
       store clone and cannot read a captured reference.  Pass a scalar, or read the value into a scalar
       before the loop (only the loop element may be a reference).
```

**The exact boundary** (both verified on `--native`):

| shape | verdict |
|---|---|
| scalar context arg — `par(r = work(i, mult), 8)` | ✅ works (and scales: 101 → 31 ms at 8 threads) |
| the loop ELEMENT is a reference — `for n in v par(r = work(n), 8)` | ✅ works |
| a captured reference — `par(r = work(i, big_struct), 8)` | ❌ **rejected** |

The diagnostic is excellent — it names the argument, the reason, and the workaround. The workaround is
just not available to us: *"read the value into a scalar before the loop"* cannot apply to a 13,077-way
graph, and *"only the loop element may be a reference"* would mean handing each worker its own copy of
the graph as the element.

**What it means for routing.** `PLAN-PERF.md` §6b B parallelises the matcher's per-stretch loop (~39
independent ~24 ms chunks, results already iterated in order). Its inputs — `g: Graph`, `ct`, `anchors`,
`ec` — are all references, so they cannot be *captured*. The path is to make each stretch a self-contained
job carrying its own slice of the corridor. That is a real refactor and it is the right shape anyway
(data-parallel = partition the data), with a measured ~4× at stake and a byte-identical-route gate already
in place.

**The docs read as if this works.** THREADING.md says *"Extra context arguments are forwarded to workers:
`par(b = scale(a, mult), N)`"* with no mention that `mult` being a scalar is load-bearing; and
*"`Stores::clone_for_worker()` creates locked copies of all in-use stores for each worker thread"* reads
as "the worker gets its own copy of everything", which is what a consumer would design against. Worth a
sentence in THREADING.md § par: *a captured argument must be a scalar; only the loop element may be a
reference.*

**Ask — now a DOC fix plus one optimisation, not a blocker.**
1. **THREADING.md § par should state the rule.** *"Extra context arguments are forwarded to workers:
   `par(b = scale(a, mult), N)`"* never says that `mult` being a **scalar** is load-bearing, and
   *"`clone_for_worker()` creates locked copies of all in-use stores for each worker thread"* reads as
   "the worker gets its own copy of everything" — which is what a consumer designs against. One sentence
   would fix it: *a captured argument must be a scalar; only the loop element may be a reference, so put
   a worker's data in the element.* The runtime diagnostic is already excellent (it names the argument,
   the reason and the workaround) — the docs just point the other way first.
2. **Optimisation, not a precondition:** let a worker read a captured reference that is provably not
   written during the loop. It would spare consumers slicing a large read-only structure per job (and the
   duplication that implies). Happy to test it against the matcher — a real ~39-chunk workload with a
   byte-identical route gate (`tools/match_parity.sh`).


## @PLN102 does not narrow through a guard clause (early return) — 2026-07-17

**loft 2026.7.1** (installed 10:39, built from `tuxedo-f2-impl-steps`). Surfaced by the sharper lint:
routing had null-flow at zero, and the new binary correctly found two real TOCTOU bugs in
`server/server.loft` (`f.exists()` then `f.content()` — the read is fallible whatever `exists()` said).
Fixing them exposed the gap. Minimal probe:

```loft
fn take(s: text) { println(s); }

fn guard(t: text) {
  s: text? = t;
  if !s { return; }      // guard clause: after this, s CANNOT be null
  take(s);               // ⚠ WARNS — "a nullable `text?` is stored into parameter 1 of `take`"
}

fn body(t: text) {
  s: text? = t;
  if s { take(s); }      // ✅ no warning — positive narrowing inside the body
}
```

**The analysis narrows inside a POSITIVE guard's body, but not after a NEGATIVE guard's early return.**
The two functions are semantically identical; only the shape differs.

**Why it matters for the definition, not just as a bug.** The guard clause is the canonical idiom for
exactly the case DN1 creates most of — "a fallible read, handle the failure and leave" — so the model
pushes you toward a shape it then refuses to credit. The available discharges are all worse:

* `?? <default>` — **actively harmful here.** The null carried the meaning (unreadable ⇒ 404). Defaulting
  answers `200` with an empty body. A lint whose easy discharge is the wrong behaviour trains the reflex
  to silence it.
* re-nest into the positive form — what routing did (`server.loft:120`), and it *is* fine at one site;
  but it forces rightward drift precisely where guard clauses exist to prevent it.

**Ask:** treat `if !x { return; }` (and `break` / `continue` / any diverging arm) as narrowing `x` to
non-null for the rest of the block — the standard flow-sensitive treatment of a diverging branch. The
information is already there: the analysis proves the negative case cannot fall through.

**Note the lint was RIGHT twice before it was incomplete once** — both TOCTOU bugs it found were real, and
the fix subtracted code (one fallible read replaces `exists()` + `content()`, since null already means
"absent OR unreadable" and both take the same path). The narrowing gap is the only false positive.


## @PLN108 step 1 — the copy cost is NOT a rounding error for this consumer — 2026-07-17

@PLN108's step 1 asks the consumer directly: *"Bench the copy cost — measure per-worker
`clone_for_worker` time. The win to beat; **if the copy is a rounding error for the consumer's shapes,
stop here.**"* Routing is the par consumer the plan cites (*"slicing a large read-only structure per job
is real work"*). **It is not a rounding error. Do not stop.**

**Probe** (`--native`, installed loft 2026.7.1 @ 10:39, 8-core): a par over 64 elements where the worker
**touches none of the big structure** — it spins on its own element only. The big `vector<Node>` is
unrelated live heap. If `clone_for_worker` byte-copies *every active store* per worker, wall-clock must
grow with heap the workload never reads. It does:

| live heap (unrelated) | par_ms (8 threads, ±2) |
|---|---|
| 0 MB | **2** |
| 3 MB | 8 |
| 15 MB | 40 |
| 30 MB | 98 |
| 61 MB | 101 |
| 122 MB | **205** |

**Confirmed — a per-worker copy.** Threads swept at a fixed 61 MB, same workload:

| threads | 1 | 2 | 4 | 8 | 16 |
|---|---|---|---|---|---|
| par_ms | 36 | 45 | 60 | 98 | **178** |

**par gets 5× SLOWER from 1 to 16 threads** — the marginal cost of each additional worker is a fresh copy
of the parent heap, and it swamps the parallel win. That is par inverted: on a session holding state, the
thing that is supposed to buy speed sells it.

**Why this is fatal for routing specifically.** The cost tracks the **session's total live heap**, not the
workload — and routing's match session exists to *hold* state (PLAN-PERF steps 6–8 made stores, Graph and
MatchState survive across clicks; RSS plateaus ~175 MB). So a par anywhere in that session pays ~200 ms+
per dispatch against a whole match of ~339 ms. **The work par would parallelise is cheaper than the copy
par charges to start.** Routing therefore cannot use par on the match path at any thread count until
@PLN108 lands — this is the real blocker, and it is a memory-model property, not an expressiveness one.

**Two corrections to my own earlier reports, since they mis-aimed this:**

1. I reported par *"cannot express this workload"* — **wrong**, and the THREADING fix (97af1b52) says why:
   large state is captured read-only, not passed. Expressiveness was never the problem.
2. I then designed around packing data **into the element** (routing's PLAN-PERF step 18). **Also wrong** —
   it doesn't dodge the copy, it *adds* to it: the parent heap is copied per worker regardless of what the
   element carries. Step 18 is being rewritten against this.

**One anomaly, reported unexplained rather than rationalised.** The curve is linear to ~30 MB and again
from ~64 MB, but **flat between them** — 30 MB (98 ms), 45 MB (103), 61 MB (101), 64 MB (96) are one
plateau, then 122 MB doubles to 205. I hypothesised a power-of-two capacity step (the copy sizing on
allocated capacity, not used bytes) and **falsified it**: 2.1M nodes shows no jump at the predicted
boundary. I have no verified mechanism, so I am not asserting one — flagging it because if the copy sizes
on something other than used bytes, step 6's "bench the win" needs to know what.

**Offer:** the probe is 20 lines and sweeps both axes; happy to hand it over as a step-1/step-6 harness, or
to re-run it against a `LOFT_PAR_SHARE=1` build on routing's real match session (the shape the plan cites)
once step 2 exists. A real consumer with a 175 MB session is exactly the case where A-vs-B gets decided.


## RETRACTED — "@PLN105 Phase 3 is not in the shipped binary" was WRONG — 2026-07-17

**I filed this and retracted it within the hour. Phase 3 IS shipped. No action needed from loft.**

> **SCOPE WARNING (2026-07-22).** This retraction is correct *about Phase 3* — and about nothing else. It
> says nothing about `lock_store`, and the pin finding above stands (re-confirmed on 2026.7.2). PLAN-PERF
> §7c read it as clearing the entire earlier entry and concluded *"step 9 is valid as written"*; step 9 was
> then attempted on that reading and hung the app. **A retraction inherits the scope of what it actually
> probed.** The two functions share a name in prose only: `deliver`'s loopback refuses `FlatArray`;
> `expose` pins. Both facts are true simultaneously.

**The claim** was that `deliver` rejects a `hash` in both top-level and nested position with *"type 69 …
is a store-internal kind — not in the serializable subset (cursor-walked in a later phase)"*, so Phase 3
(keyed collections pre-flattened) had not landed despite @PLN105 closing on it.

**Why it was wrong.** The probes were real, but they measured the **loopback test reconstructor**, not the
bridge. `deliver_reconstruct` → `read_via_descriptor` (`descriptor.rs:732`) refuses `Iterated` / `Ref` /
`ChildRec` / **`FlatArray`** — and `FlatArray` is *precisely what Phase 3 emits for a hash*. So the error
text is the loopback saying "I don't walk keyed collections", which the plan itself says is deferred there.

The path routing actually uses is `expose`, and it is a **different function** that never touches
`read_via_descriptor` (`ffi_deliver.rs:56`):

```rust
pub fn expose_value(&mut self, tag: i64, val: DbRef, db_tp: u16) {
    #[cfg(all(target_arch = "wasm32", not(target_os = "wasi"), not(feature = "wasm")))]
    {
        let mut desc = self.layout_descriptor(&[db_tp]);
        let mut flat: BTreeMap<u64, u32> = BTreeMap::new();
        self.collect_keyed(&desc, db_tp, val, &mut flat);   // <- Phase 3, right here
        Self::rewrite_iterated(&mut desc);
        let json = desc.to_delivery_json(&flat);            // <- the (rec,pos) flat redirect map
        self.lock_store(&val);                              // <- the cross-frame pin
        crate::loft_host_expose(tag, store_base, val.rec, val.pos, ..., json.as_ptr(), json.len());
```

`collect_keyed` + `to_delivery_json(&flat)` **is** the plan's *"hash/radix/index → key-ordered scratch
array → `FlatArray` … multi-instance via a `flat` redirect map keyed by `(rec,pos)`"*. It shipped.

**Two traps, both of which CLAUDE.md names, both of which I walked into anyway:**

1. **I concluded from the wrong path.** `deliver`'s loopback is a *test host*; `expose` is the browser
   bridge. Same word ("deliver a hash"), different function — and I never checked which one routing's own
   step 9 calls.
2. **A silent no-op read as evidence.** `expose(1, l.tiles)` printed nothing on the plain backend and I
   treated that as uninformative rather than as the tell: the body is `#[cfg(target_arch = "wasm32")]`, so
   there was nothing to see off the `--html` target. **Absence of output was a fact about my probe, not
   about loft.**

**Consequence for routing:** PLAN-PERF step 9 (`expose(1, layout)` — the layout hash, exposed once per
session) is **valid as specified**. The hash is pre-flattened by `collect_keyed` and JS walks it via the
descriptor. §7c corrected accordingly.


## @PLN108 — the copy-elision WIN has no automated gate, and it is inactive on the installed release — 2026-07-17

**Installed loft 2026.7.1 (reinstalled 17:45, from `../loft` HEAD `cdc48c06`; @PLN108 merged as #586).**
This is a gate-coverage finding, not a null-flow one, and it is filed because the consumer (routing) runs
the *release*, not a dev build — and on the release the win routing was waiting for (step 18) is absent.

### The measurement (anchored — NOT a stale binary)

`tools/par_copy_probe.loft` — a queue par whose worker touches none of a large captured heap. On loft2's
dev binary this showed the copy eliminated (flat vs heap, ~53×, my checksum `383995`). On the installed
release it shows **no win**, both backends, tight variance:

```
122 MB heap:  native  OFF 218/214/197   ON 215/213/219      (LOFT_PAR_SHARE=1)
              interp  OFF 212/213/216   ON 210/224/205
61 MB, thread-scaling:  OFF 1→16 thr = 40→173 ms · ON = 33→162 ms
```

The thread-scaling is the tell: under a live borrow, `ON` at 16 threads is FLAT (no per-worker copy). It
climbs to 162 ms — **the per-worker copy is still happening with the flag on.** `AUTO` (unset) at 122 MB
is also ~214 ms, though 122 MB ≥ the 2 MB `PAR_SHARE_MIN_BYTES` threshold should elect the borrow.

### It is not a stale rlib (the obvious suspect, checked)

- installed runtime `deps/libloft.rlib` = **17:45**, and it CONTAINS the symbols: `run_parallel_queue_shared`
  (36), `par_share_for` (3), `borrow_locked_for_light_worker` (8), `clone_for_light_worker` (13).
- compiled probe `tools/.loft/cache/par_copy_probe-*` = **17:50**, built against that rlib.

So the borrow code is physically present in the linked runtime, freshly built, and still does not take
effect for this shape. Prime remaining suspect: the CLAUDE.md binary/runtime split — loft2 measured the
win on a `cargo build` (binary + rlib compiled together); the release links the *separate*
`deps/libloft.rlib`. "Present but not wired" fits every observation. I cannot instrument further without
building in `../loft` (read-only), so I stop at the anchored measurement and do not assert the mechanism.

### Root cause of how this shipped: the WIN IS UNTESTED

Nothing in @PLN108's acceptance bar asserts the copy is elided — only that it stays SAFE:

| layer | asserts | passes under clone? | passes under borrow? |
|---|---|---|---|
| `par_queue_does_not_grow_parent_stores` | parent alloc count unchanged | ✅ | ✅ |
| `par_queue_single_thread_matches_multi` | order + values | ✅ | ✅ |
| `parallel_store_is_read_only_in_workers` | worker write panics | ✅ | ✅ |
| `borrow_locked_reads_original_data` | the **primitive** shares the buffer | — (bypasses the dispatcher) | ✅ |
| S5/S6 gates (ASan / TSan) | no UAF / no race | ✅ (cloning is safe) | ✅ |

Every gate is green whether the dispatch borrows or silently clones. The only borrow-specific test
constructs a `Store` and calls `borrow_locked_for_light_worker()` directly — it never routes through
`par_share_for → run_parallel_queue_shared`, so it cannot catch a dispatch fallback. **The elision — the
entire point — has no gate at any level**, which is exactly how a release can ship it inactive and stay
47/47 + ASan + TSan.

### Ask — add the missing end-to-end elision gate

Mirror how the win was actually confirmed during S9 (call-count traces): under `LOFT_PAR_SHARE=1`, assert
`clone_for_light_worker` (borrow) is called and `clone_for_worker` (copy) is NOT, for a queue par carrying
a captured store ≥ `PAR_SHARE_MIN_BYTES` — on the **native** dispatch, the family routing uses. A
call-count assertion is deterministic where timing is not. `tools/par_copy_probe.loft` is the loft-source
half of the basis and is offered as-is; it is currently RED on the installed release and would make a good
consumer smoke-test once the gate is green.

### Consequence for routing

**Step 18 stays blocked.** @PLN108 merged, but the copy-elision it promised does not manifest on the loft
routing runs. Re-run `tools/par_copy_probe.loft` after the next release; unblock step 18 only when `ON` goes
flat vs heap there.

> **SUPERSEDED 2026-07-22 — the win is live on 2026.7.2 and step 18 is unblocked.** See
> *"@PLN108 — the copy-elision win is ACTIVE"* below. The gate-coverage ask stands; the consumer
> complaint does not.

---

## 2026-07-22 — `expose` UN-RETRACTED: it is ITERATION that claims, not reading (loft 2026.7.2)

**Installed loft 2026.7.2** (`/usr/local/bin/loft`, reinstalled 2026-07-22 09:01 — the @PLN110 len/size
flip release). All four routing gates pass on it unchanged, so this is not fallout from the flip.

**This entry settles a claim that flipped twice in one hour on 2026-07-17.** The original finding
(*"@PLN105 `expose`/`deliver`: a store you expose becomes unreadable"* § 1, above) was **CORRECT** — its
repro, its panic text, and its named mechanism all reproduce verbatim on the current release. The
retraction (*"RETRACTED — @PLN105 Phase 3 is not in the shipped binary"*, above) was right about its own
subject — Phase 3 *is* shipped, `collect_keyed` *does* pre-flatten the hash — but it did **not** touch the
pin, and PLAN-PERF §7c wrongly read it as clearing the whole entry. Step 9 was then attempted on that
reading and hung the app (§7d).

### The narrowing the original entry did not have: reads are fine

Same probe shape as § 1, but each operation in its own process against the real 20 MB layout store
(`_site/stores/enschede.layout.store`, 1089 tiles), `loft --native --lib lib`. Kept as a durable probe —
**`tools/expose_iter_probe.loft`**, `op = read | iter | release` — so it can be re-run against each loft
release the way `tools/par_copy_probe.loft` is:

| after `expose(1, layout)` | result |
|---|---|
| nothing at all | ✅ |
| `len(layout)` | ✅ `1089` |
| `layout[2047327105]` — point lookup | ✅ `tkey=2047327105 ox=68600000` |
| field reads + `"{t.tkey} ox={t.ox}"` text interpolation | ✅ |
| **`for t in layout { }` — empty body** | ❌ **panic** |

```
thread panicked at src/store.rs:647:9:
Claim on read-only store (size=546) (locked by: lock_store(store_nr=1, rec=1))
```

So it is **not** that "loft cannot read an exposed store" — reads, lookups and text built from its records
all work. It is that **iterating a store-backed keyed collection CLAIMS a 546-byte cursor record inside
that same store**, and the read-only pin rejects the claim. An *empty* loop body fails, which places the
claim in the iteration machinery itself, not in anything the body does.

Reproduces identically on `loft` (default) and `loft --native`.

### `release(tag, value)` restores iteration — the workaround the original entry lacked

```loft
store_load(layout, path);
expose(1, layout);                     // pin for JS
release(1, layout);                    // unpin
for t in layout { n += 1; }            // ✅ ITERATE AFTER RELEASE OK n=1089
expose(1, layout);                     // ✅ re-expose works
```

This is what makes PLAN-PERF steps 9–13 buildable **today**, with no upstream change: bracket loft's own
layout walk in `release` … `expose`. It also restores the safe migration order the original entry said was
blocked — land the JS reader beside the text path, compare, then delete the text path — because during the
overlap loft can unpin, emit, and re-pin.

### Correction to our own method note (PLAN-PERF §7d)

§7d says `expose` *"is a silent no-op off the `--html` target … so nothing can be learned about it from
`loft file.loft`"*. **That is wrong, and it is why the 2026-07-17 session paid for this in the browser.**
Only the *host-call* half is `cfg`-gated; `lock_store` runs on **every** target (`ffi_deliver.rs:80-84`):

```rust
#[cfg(not(all(target_arch = "wasm32", not(target_os = "wasi"), not(feature = "wasm"))))]
{
    let _ = (tag, db_tp);
    self.lock_store(&val);      // <- the pin, on every backend
}
```

The whole diagnosis above came from one native run of `client/basemap_kernel.loft` — the path-loading twin
of the browser kernel — with `expose(1, layout)` added after `store_load`. The browser hang and the native
panic are the same event; in wasm it surfaces as a silent trap (the kernel dies mid-command, never emits
its terminator, the page waits forever, no JS exception), which is exactly what §7d observed.

**The generalisable lesson:** when a browser-only symptom has a non-browser code path underneath it, probe
the non-browser path first. A `cfg` on *part* of a function is not a `cfg` on the function.

### Ask (unchanged in substance from § 1, now with the mechanism pinned)

A read-only iteration should not need to claim scratch **inside the pinned store**. Either allocate the
cursor record outside the locked store, or let the read-only lock permit cursor claims. Failing that,
`expose` needs documenting as *"loft must not ITERATE this store until `release`"* — reads are fine, so the
current blanket phrasing would be both wrong and unhelpfully broad. Neither the stdlib comment
(`default/02_files.loft:107-110`) nor `BROWSER_INTEROP.md:297` says anything about it, and the failure
lands far from the call.

### Consequence for routing

**Steps 9–13 are unblocked and need nothing from loft.** Step 9's row must change, though: it is specified
as an *additive* one-liner landing beside a still-emitting text path, and that specific shape is the one
that cannot work — the text path iterates the layout. Use the release/expose bracket.

---

## @PLN108 — the copy-elision win is ACTIVE on 2026.7.2; step 18 unblocked — 2026-07-22

Re-ran `tools/par_copy_probe.loft` on the installed 2026.7.2 per the previous entry's own instruction
(*"unblock step 18 only when `ON` goes flat vs heap there"*). It is flat — and flat with the flag
**unset**, so sharing is now the default dispatch, not an opt-in:

```
par_ms, --native, LOFT_PAR_SHARE unset:
  heap    0 MB:  1 thr 3 · 8 thr 1 · 16 thr 1
  heap   61 MB:  1 thr 2 · 8 thr 3 · 16 thr 3
  heap  122 MB:  1 thr 3 · 8 thr 2 · 16 thr 3
```

Against the 2026-07-17 measurement on 2026.7.1 — 122 MB heap ≈ **214 ms** regardless of the flag, and
1→16 threads climbing **33 → 162 ms** — the per-worker copy is gone. Upstream credit: `ae0c266b`
(*"@PLN108 par-store single-impl"*, 2026-07-18), i.e. the fallback the previous entry suspected
("present but not wired") was resolved by collapsing the two implementations into one.

**The gate-coverage ask still stands.** Nothing in this measurement contradicts it: the win shipped
inactive once precisely because no test asserts elision, and a single-impl refactor is not a substitute for
a gate that would have caught the fallback. `tools/par_copy_probe.loft` is now GREEN on the release and is
offered as the consumer-side smoke test.

**Step 18 is unblocked** — `par` over the stretches is designable again.

---

## 2026-07-22 — `expose` RE-FLATTENS the whole collection on every call, and the pin forces you to call it repeatedly

**Installed loft 2026.7.2.** This is the sequel to the iteration finding above, and the two compound: that
one says you must `release` before loft touches the store, this one says re-`expose`ing afterwards is
**O(collection)**. Together they make a per-frame bridge cost proportional to the data, which is exactly
what the consumer adopted the bridge to escape.

### What the contract implies vs what it costs

`BROWSER_INTEROP.md:297` and the stdlib comment both frame `expose` as the *long-lived* variant —
*"pins the value's store; read it each frame"* — which reads as **expose once, hold it, JS reads for
free**. That is true only if loft never touches the store again. A consumer that still iterates it (here:
`do_view_bbox` walks the layout to emit its text, during the additive overlap of a migration) must
bracket every command as `release` → walk → `expose`. And each `expose` runs the full Phase 3 pipeline
again (`ffi_deliver.rs:56` → `collect_keyed` → `build_hash_sorted_vec`): a fresh **key-sorted
materialisation of every element**, a scratch record allocation, and a descriptor-JSON rebuild.

### Measured (A/B on the same binary, same store, same harness)

Enschede layout store: 20 MB, **1089 `PTile`s, ~230k nested features**. Headless Chromium at
`CPU_THROTTLE=4`, medians of 6, via `tools/map_profile.sh`. The only difference is the two-line bracket:

| | with `release`/`expose` per view | without | delta |
|---|---|---|---|
| **empty-bbox view** — emits NOTHING, so this is scan + bracket only | **483 ms** | 253 ms | **+230 ms** |
| full view, kernel | **1141 ms** | 721 ms | +420 ms |
| full view, total | **1447 ms** | 927 ms | **+56%** |
| wasm binary | 1 098 479 B | 1 048 840 B | +48 KB |

The empty-bbox row is the clean one: it emits no features, so ~230 ms is the bracket alone. **Not a
leak** — wasm working set was 254.9 MB with the bracket vs 265.1 MB without, i.e. no growth attributable
to the repeated scratch allocations.

### Ask (either one removes it; the second is better)

1. **Make re-`expose` cheap on an unmodified store** — cache the flattening and the descriptor, and
   invalidate on write. A `release`/`expose` pair that brackets a pure read would then cost ~nothing,
   which is what the "read it each frame" contract already implies to a reader.
2. **Let loft ITERATE a pinned store.** The bracket exists only because a read-only iteration claims a
   cursor record inside the pinned store (the finding above). Fix that and the consumer never releases,
   so the re-flattening never happens — one `expose` per session, as the docs suggest.

Failing both, the docs should say plainly that `expose` is **O(collection) per call**, so a consumer can
see that bracketing it per frame is not viable.

### Consequence for routing

Absorbed deliberately and temporarily: PLAN-PERF steps 11–12 land the store-read path *beside* the text
path, so the overlap pays both. **Step 13 deletes the text emit**, after which nothing in loft iterates
the layout, the bracket collapses to a single `expose` at load, and this cost goes to zero. Recorded so
the interim number is not mistaken for a regression in the bridge itself — the bridge is fine; calling it
per frame is what costs.

---

## 2026-07-22 — codegen: a text field read off a struct-RETURNING CALL emits `&str` where `String` is expected

**loft:** 2026.7.2 (installed, `/usr/local/bin/loft`) · **backend:** `--native` only (the interpreter is fine)

Reading a `text` field **directly off a call that returns a struct** fails to build natively. Binding the
returned struct to a local first compiles and behaves identically.

```loft
struct WayTags { const highway: text, /* … */ }
fn etags(g: Graph, e: GEdge) -> WayTags { g.wtags[e.w] ?? empty_tags() }

c = road_class(etags(g, e).highway);   // ✗ native build fails
et = etags(g, e);                      // ✓ same thing, bound first
c = road_class(et.highway);
```

The generated Rust returns a `&str` into a slot typed `String`:

```
error[E0308]: mismatched types
  --> lib/routing_kernel/native-auto/loft_auto_routing_kernel.rs:2225:87
     let mut var___ret_1: String = {{ let db = (var___lift_1);
         if db.rec == 0 { loft::state::STRING_NULL } else { … store.get_str(…) } }};
                                    ^^^^^^^^^^^^^^^^^^^^^^^^ expected `String`, found `&str`
```

rustc even names the fix in its own hint — `STRING_NULL.to_string()` — so the lift path for a
store-backed `text` is missing an owned conversion on this one shape. Note the error is reported at the
generated-Rust level, i.e. it escapes loft's own type checking: the loft program is well-typed and the
failure surfaces as a rustc error against a file the user did not write.

**Where it bit:** `lib/routing_kernel/src/routing_kernel.loft`, moving per-edge tags behind a per-way
table (edges went from 14 fields to 4; cold match 2721 → 1820 ms). Two sites needed the local-binding
workaround and carry a comment pointing here.

**Not a blocker** — the workaround is one line and arguably reads better. Filed because the *shape* is
ordinary (accessor function returning a record, read one field), it only fails on `--native`, and it
fails as a rustc error rather than a loft diagnostic, which is a poor first experience for anyone who
meets it without knowing to bind the struct.
