<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Request to loft — a zero-copy binary bridge (loft-wasm → JS)

**Audience:** the loft agent (this is a `loft-lang/loft` capability request; `routing` is the first
consumer). Written to be read cold.

**The gap.** loft-wasm **outbound is text-only** today: `println` → `loft_host_print(ptr,len)` and
`host_output(msg)` → `loft_host_output(ptr,len)` both carry `text`. The **inbound** side already has
binary (`store_load_url_trusted`'s fetch → `loft_host_http_get`/`_copy` hands bytes into loft). We need the
**outbound binary** side — and at the **zero-copy** bar, because two consumers depend on throughput:

- **routing (now):** the base-map `view` currently serializes ~230k features to **text** in wasm, which JS
  re-parses with `parseFloat` over millions of coordinate strings — the front-end bottleneck. We want to
  hand JS the coordinate/attribute buffers directly.
- **games (the reason it must be fast):** per-frame vertex / index / uniform buffers. Any O(n) serialize on
  the hot path defeats the purpose; `gl.bufferData(view)` must copy **wasm memory → GPU** directly, with no
  intermediate JS array and no per-frame allocation.

This is a load-bearing primitive, so it is specified below as **one invariant + enumerated failure paths +
falsification/perf probes** (Design Protocol 1), not a sketch.

---

## The one invariant

> JS obtains a **typed-array view over the exact bytes of a loft `vector<T>` (or single value) in wasm
> linear memory** — no serialization, no copy — for a defined **borrow window**, with the *element type/
> layout*, *element count*, and *byte offset* delivered alongside, so JS constructs the correct view
> (`Int32Array` / `Float32Array` / a strided record view) over the module's exported `WebAssembly.Memory`.

`T` is a **scalar** *or* a **packed record** (a struct of scalars — see *Records* below). The four shapes a
consumer needs are all this one primitive: a single scalar, a `vector<scalar>`, a single record, and a
`vector<record>`.

Everything a consumer wants — routing's structured `view`, a game's vertex upload — is composed on this one
primitive. If the invariant holds, `deliver` is **O(1)** regardless of `n`; that O(1)-ness *is* the
requirement (probe 3).

---

## The primitive

### Core — deliver a vector's backing to JS (push)

A loft builtin, generic over `T` (a **scalar** or a **packed record** — see *Records*), that hands JS the
backing of a `vector<T>` without copying it:

```loft
// Deliver `data`'s backing bytes to the JS host, tagged so the app routes them. Zero-copy: no bytes are
// moved; JS receives (ptr, count, elemType[, record layout]) and views wasm memory directly. Valid only
// during the call.
pub fn deliver(tag: integer, data: vector<T>);          // T = a scalar (table below) or a packed record
pub fn deliver_value(tag: integer, v: T);               // a single scalar or record (count == 1)
```

Lowering (on `--html`) — one JS import loft calls:

```
loft_host_deliver(tag: i32, ptr: i32, byteLen: i32, elemType: i32, count: i32)
```

JS side (the shell provides this; the app registers a handler):

```js
const TA = [Uint8Array,Int8Array,Uint16Array,Int16Array,Uint32Array,Int32Array,
            BigUint64Array,BigInt64Array,Float32Array,Float64Array];
loft_host_deliver: (tag, ptr, byteLen, elemType, count) => {
  const view = new TA[elemType](memory.buffer, ptr, count);   // zero-copy view over wasm memory
  globalThis.loftDeliver(tag, view);                          // app consumes it SYNCHRONOUSLY (see contract)
}
```

`ptr` points at the vector's **element data** (not a header). `count = len(data)`; `byteLen = count *
elemSize`. `tag` is a caller-defined `u32` the app switches on (0 = vertices, 1 = indices, 2 =
view.buildings.coords, …). Multiple `deliver` calls compose a structured message (the consumer knows the
set is complete from a terminating `deliver`/`println`).

### Element types (`elemType`)

| loft type | bytes | `elemType` | JS view |
|---|---|---|---|
| `u8` / `i8` | 1 | 0 / 1 | `Uint8Array` / `Int8Array` |
| `u16` / `i16` | 2 | 2 / 3 | `Uint16Array` / `Int16Array` |
| `u32` / `i32` | 4 | 4 / 5 | `Uint32Array` / `Int32Array` |
| `integer` (i64) / u64 | 8 | 7 / 6 | `BigInt64Array` / `BigUint64Array` |
| `single` (f32) | 4 | 8 | `Float32Array` |
| `float` (f64) | 8 | 9 | `Float64Array` |

**Little-endian throughout** (wasm's byte order == every JS typed array's) — no swap.

### Records (packed structs) — first class

`deliver` / `deliver_value` accept a **packed record** for `T`: a `struct` whose fields are all scalars
(above), with a **defined field order, no padding, and no pointers/nested vectors** — so `vector<Record>`
has a **contiguous, interleaved byte image** JS can view directly. This is the case games care about most
(interleaved vertex attributes — position + normal + uv in one struct → one buffer), and it lets routing
deliver a feature record instead of parallel arrays.

For a record delivery, loft passes `elemType = RECORD` and, alongside `(ptr, byteLen, count)` (so `stride =
byteLen / count`), a **field layout**: the list of `(fieldByteOffset, fieldElemType)`. Two ways loft can
surface it — the agent's call; either is fine:
- a companion **pull** accessor `loft_record_layout(tag) -> [nFields, (off, elemType)…]` JS reads once, or
- a small self-describing header (the layout as a `u32` block) delivered under a reserved tag before the data.

JS then has two modes, both zero-copy:
- **Raw upload (games):** ignore the layout, `gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(mem.buffer, ptr,
  byteLen))`, and describe attributes to the GPU with `stride` + each field's `(offset, type)` via
  `gl.vertexAttribPointer` — exactly the interleaved-VBO model, no repack.
- **Field access (routing):** build strided views (`new Float32Array(mem.buffer, ptr + off, count)` read with
  `stride/4`, or a `DataView` walk) to read fields — still no serialization.

`struct` fields that are themselves vectors, `text`, or references are **not** packed records (they hold heap
pointers, not inline bytes) → not zero-copy deliverable; the consumer flattens them into scalar buffers +
offsets itself (see routing's `view` below). Same FLAT rule as `store_load_key`.

---

## The two usage patterns (both on the one primitive)

- **Push (occasional / structured):** loft calls `deliver` one or more times; JS consumes each view during
  the call. Fits routing's `view <bbox>` — emit a coord buffer per layer + a feature table + a string pool,
  each tagged; JS reassembles.
- **Pull / persistent (hot loops):** loft allocates a **stable** `vector<T>`, exposes its descriptor **once**,
  writes into it in place each frame, and JS **re-views** it per frame (re-deriving from `memory.buffer` —
  see growth hazard). **No per-frame bridge call**, no allocation — the peak-throughput game path. This
  needs a pull companion:

  ```loft
  // A stable descriptor JS can query by tag; loft keeps `v` pinned & un-grown for the app's lifetime.
  pub fn expose(tag: integer, v: vector<T>);   // register once; JS reads via an exported accessor
  ```
  lowering to an **exported** loft function `loft_buffer_desc(tag) -> (ptr, count, elemType)` JS calls each
  frame. (Double-buffer to write frame N+1 while JS reads frame N.)

---

## The borrow contract (the load-bearing safety design)

The zero-copy view aliases live wasm memory, so the window is tight and explicit:

1. **Synchronous window.** A pushed view is valid **only for the `loft_host_deliver` call**; a pulled view
   only until control returns to loft (which may write/grow).
2. **No `memory.grow` during the window.** A grow **detaches** the current `ArrayBuffer`; every outstanding
   view throws / reads garbage. loft must not grow between handing out a descriptor and the read completing.
3. **No free / move / realloc of the value during the window.** loft pins `data` for the window (an arena
   compaction or a `vector` push that reallocs mid-read is a use-after-free for JS).
4. **JS must not retain the view.** To keep the bytes, JS **copies** (`view.slice()`) or **uploads**
   (`gl.bufferData` / `texImage2D` copy into the GPU) *inside* the window.
5. **JS always re-derives from `memory.buffer`.** Never cache the `ArrayBuffer` across calls — it changes on
   any grow.

These five are the whole safety story; a consumer that obeys them cannot corrupt.

---

## Failure paths (enumerated — where the invariant breaks)

- **Growth-detach** — grow mid-read → detached buffer. *Mitigation:* contract §2 + §5; probe 2.
- **Lifetime / relocation** — value freed or moved (arena compaction, `vector` realloc) mid-read →
  use-after-free. *Mitigation:* contract §3.
- **Non-flat elements** — a `vector<struct>` whose fields are heap pointers / nested vectors has **no
  contiguous byte image** to view. *Constraint:* zero-copy applies to **flat** elements only — a scalar, or
  a **packed struct of scalars** (defined field order, no padding, no pointers) delivered as an interleaved
  typed array (e.g. `struct Vert { x,y,z: single }` → a `Float32Array` of `3*count`). Nested/pointer
  elements are **out of scope** (they need serialization — the consumer's job). This mirrors
  `store_load_key`'s existing FLAT-struct restriction.
- **Alignment** — `Float32Array`/`Int32Array` require 4-byte, `Float64`/`i64` 8-byte alignment. loft's
  typed-vector backing must be element-aligned (state it as a guarantee).
- **Type-tag drift** — the only cross-boundary agreement is `elemType`; JS is generic (switches on it), so
  loft is the **single source of truth**. `N = 1` re-assertion (loft declares; JS follows) — no silent
  drift. Probe 1 makes any mismatch loud.

---

## Targets

- **`--html`** (primary) — the zero-copy JS view. The whole point.
- **`--native-wasm` (WASI)** — no JS host; deliver via a documented sink (e.g. length-prefixed binary frames
  on stdout: `[tag u32][elemType u8][count u32][bytes]`) so the same loft program is testable head-lessly
  and under wasmtime.
- **native** — a copy-based equivalent to the same sink, so `deliver(...)` compiles and runs on every
  backend (only the browser path is truly zero-copy; native/WASI may copy). One loft source, all targets.

---

## Validation probes (please build these — they *are* the spec's teeth)

1. **Round-trip per element type + record** *(correctness).* loft builds `vector<T>` of known values for
   each scalar `T ∈ {u8, i16, i32, i64, f32, f64}` **and** a packed record `struct Rec { id: u32, x: single,
   y: single }` (mixed widths — catches padding/offset bugs); `deliver(tag, v)`; JS reads the view (and, for
   the record, walks the field layout at the given offsets) and compares to the expected bytes/values.
   Falsifies "the bytes, type, count, **and field offsets** are delivered correctly." Run on `--html` and
   `--native-wasm` (framed-stdout) — values must match across targets.
2. **Memory-growth hazard** *(the contract).* Between two deliveries, force a `memory.grow`. Assert: a view
   **retained** from before the grow is detached (documents that retaining is illegal), and a view
   **re-derived** from `memory.buffer` after the grow reads correctly. Falsifies "JS may keep views."
3. **Zero-copy performance** *(the reason this exists).* `deliver` a large `vector<single>` (1M, 8M f32) and
   measure: loft-side `deliver` cost and JS view construction must be **O(1)** — flat across sizes and
   **independent of `n`**. Baseline: the same data via text/`println` (O(n) format + `parseFloat`).
   **Prediction to falsify:** `deliver` is O(1); text is O(n); crossover is tiny. If `deliver` time scales
   with `n`, it is copying — the design has failed and must be fixed before anything builds on it.
4. **GPU upload (games path)** *(end-to-end).* `deliver` an interleaved vertex `vector<Vert>` (record:
   `struct Vert { pos: 3×single, nrm: 3×single, uv: 2×single }`) → `gl.bufferData(GL_ARRAY_BUFFER, new
   Uint8Array(mem.buffer, ptr, byteLen))` + `gl.vertexAttribPointer` using `stride` and each field's
   `(offset, type)` — **no** intermediate JS array, no repack. Measure per-frame cost (≈ memcpy-to-GPU) and
   confirm no per-frame allocation (steady heap under a repeated loop).

---

## How the consumers use it (motivation, not part of the ask)

- **routing `view <bbox>`** — replace the tagged text lines with, per layer: one `vector<i32>` of absolute
  fixed-point coords (`deg*1e7`, exact — the text was a lossy 6-dp view), one `vector<u32>` feature table
  (attr refs + per-feature point offset/count), one `vector<u8>` string pool (UTF-8 names/classes). JS
  reassembles the exact layer arrays `parseView` produces — **zero `parseFloat`** — and the renderer can draw
  straight from the typed arrays. (Coordinate round-trip check vs the text path: `i32/1e7` rounded to 6 dp
  equals the text.)
- **games** — vertex / index / uniform buffers per frame via the persistent-buffer pattern; `gl.bufferData`
  / `gl.bufferSubData` straight from the view.

---

## Inbound symmetry (note — lower priority, not blocking)

The mirror (JS → loft binary) is currently special-cased as `store_load_url`'s fetch. A general
`host_receive(tag) -> vector<u8>` (JS pushes bytes via `loftPush`-of-bytes, loft pulls) would symmetrize the
bridge for uploaded assets/textures. Useful later; the **outbound** primitive above is what unblocks both
consumers now.

## Non-goals

- Not a serialization *format* — that is each consumer's job on top (routing's layer layout, a game's vertex
  layout). loft moves **bytes + type + count**, nothing more.
- Not nested / pointer-graph transfer (flat elements only).
- Not a shared-memory GC contract beyond the borrow window.
