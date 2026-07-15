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
