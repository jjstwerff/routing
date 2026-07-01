# loft feedback from the `routing` consumer

**Date:** 2026-07-01 · **loft:** 2026.6.0 (git `e7c0f17b`) · **libs:** `loft-libs-net/web` 0.1.1 (local) / 0.2.0 (registry)

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

6. **`web` monorepo checkout is version-skewed and won't compile.** `loft-libs-net/web` is **0.1.1**
   locally but the registry ships **0.2.0**; the 0.1.1 source **fails to compile under current loft**:
   `web/src/web.loft:206` — `if !ws_client_recv_native(self.id) { return null; }` →
   *"`null` cannot be stored into the return value of the non-null scalar type `text` — declare it
   `text?`"*. Anyone path-dep'ing the local source (instead of the registry) hits this immediately.
   **Fix:** sync the checkout to 0.2.0, or fix line 206 to return `text?` / a non-null sentinel.

7. **`~/.cache/loft` staleness gotcha** (already documented at `WASM.md:686`) bit us when iterating
   `--html` after an `--interpret` run of the same program — the fix (`rm -rf ~/.cache/loft`) works.
   Good that it's documented; `WASM.md` already flags auto-invalidation as a candidate fix — worth
   doing, it's a sharp edge.

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
