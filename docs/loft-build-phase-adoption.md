<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Adopting loft's build phase (@PLN100) for routing

**Status:** the **GitHub Pages build is now automated via `loft build`** (implemented + validated). @PLN100
has since been installed — the **installed `/usr/local/bin/loft` now has the build phase**, so `loft build`
works locally with plain `loft` (validated: `loft build` → `_site/index.html`, incremental). It is **not yet
on loft `main`** (origin/main is still @PLN98), so the Pages *workflow* still pins loft to the
`tuxedo-pln100-build-phase` branch. Reference: loft `doc/claude/PACKAGES.md` § "The build phase".

> ⚠ **Install caveat (2026-07-08):** the @PLN100 install refreshed the loft binary + `libloft.rlib` (rustc
> 1.96.1) but left a **stale `libloft_ffi`** compiled by rustc 1.96.0 in `/usr/local/share/loft/deps`, so
> **`--native` builds fail `E0514`** (incompatible rustc). Interpret + `--html`/wasm are fine (S0, kernel
> tests, and this Pages build all pass — the html target never touches native). Fix is a **clean loft
> re-install** (rebuilds `loft_ffi`); until then routing's *native* path (`make build`, server gate) is
> blocked, the *browser/Pages* path is not.

## What @PLN100 gives us

A Cargo/Make analogue built into `loft.toml`:
- **`[build]` + `[build.target.<name>]`** (shape × triple × features + `requires`) → `loft build [targets]`.
  Built-in `native` / `html` / `wasi` targets are implicit.
- **`[[build.asset]]`** — turn `inputs` into `outputs` via a `run` (a `.loft` script *or* any shell command),
  re-run only when **stale**: output missing, inputs' *content* changed (fingerprint, survives CI mtime
  resets), or a `lifetime` TTL expired (`s/m/h/d/w/mo/y`, for external-source data). `--force` = clean.
- **`[[test]]` + `loft check`** — build default targets → run assets → run declared tests, one exit code.
  Tests run over `interpret` / `native` backends; **green-run cached** by `(script + inputs + target)` so
  `loft check` is incremental.
- **Slice 1:** `loft --html` / `--native-wasm` now **auto-build their (isolated) wasm runtime rlib** — no
  manual `make` step, no rlib-stomp between the html and wasm-bindgen shapes.

## Why routing wants it

Our build is spread across a `Makefile` (`build`/`install`/`test`/`test-native`/`test-wasm`/`test-client`/
`test-standalone`), **eight** `tools/*.sh` harnesses, `browser/build.mjs` (wasm + 4 emitters + stamp) and
`browser/build-standalone.mjs` (inlines everything). Two concrete pains @PLN100 fixes:
- **No incrementality:** every `node browser/build.mjs` re-runs all four emitters + the wasm build
  unconditionally. `[[build.asset]]` fingerprints inputs → each layer rebuilds only when its fixture,
  emitter, or lib changes.
- **No single gate:** `make test` + `test-native` + `test-wasm` are separate; `loft check` is one
  incremental build+test exit code for CI.

## The mapping

| Current | @PLN100 |
|---|---|
| `make build` → `loft --native-release --check server/server.loft --lib lib` | `[[build.asset]] server-bin` (or a `native` target once multi-entry lands — see gaps) |
| `build.mjs`: `loft --html client/web_kernel.loft` → extract → `web_kernel.wasm` | `[[build.asset]] web-wasm`, `targets = ["html"]` |
| `build.mjs`: `emit_areas.loft <fixture>` → `areas.txt` (×4: areas/buildings/places/streets) | four `[[build.asset]]` steps, one per layer |
| `build.mjs`: osm3s snapshot → `stamp.txt` | `[[build.asset]] stamp` |
| `build-standalone.mjs`: inline all → `standalone.html` | `[[build.asset]] standalone`, `needs`/inputs = the layer outputs |
| `make test` (kernel suites via `loft --tests` + server harnesses) | `[[test]]` entries over `interpret` + `native` |
| `tools/basemap_isolation_gate.sh` (S0) | `[[test]] isolation` (interpret) |
| `tools/browser_app_test.sh`, `standalone_app_test.sh`, `client_*` (headless Chromium) | **stays shell** — no `html` test backend yet |

## Target `loft.toml` (routing root)

```toml
[package]
name = "routing"
version = "0.1.0"

[build]
default-targets = ["native", "html"]        # `loft build` makes the server + the browser wasm

# --- presentation layers: classify a fixture in loft → a browser text file (rebuild only on change) ---
[[build.asset]]
name    = "areas"
run     = "client/basemap/emit_areas.loft client/basemap/fixtures/real_stretch_areas.sample.json browser/areas.txt"
inputs  = ["client/basemap/emit_areas.loft", "lib/basemap/**/*.loft", "client/basemap/fixtures/real_stretch_areas.sample.json"]
outputs = ["browser/areas.txt"]
targets = ["html"]
# …buildings / places / streets: identical shape with their fixture + emitter…

[[build.asset]]
name    = "web-wasm"
run     = "node browser/build-wasm.mjs"      # loft --html + extract the base64 wasm (trimmed build.mjs)
inputs  = ["client/web_kernel.loft", "lib/routing_kernel/**/*.loft", "lib/basemap/**/*.loft"]
outputs = ["browser/web_kernel.wasm"]
targets = ["html"]

[[build.asset]]
name    = "standalone"
run     = "node browser/build-standalone.mjs"
inputs  = ["browser/index.html", "browser/web_kernel.wasm", "browser/areas.txt", "browser/buildings.txt",
           "browser/places.txt", "browser/streets.txt", "browser/vendor/leaflet/*"]
outputs = ["browser/standalone.html"]
targets = ["html"]

# --- tests: the same suites the Makefile runs, now one `loft check` gate ---
[[test]]
name    = "kernel"
run     = "tools/run_kernel_tests.loft"      # loops the KERNEL_TESTS the Makefile lists
targets = ["interpret", "native"]            # mirrors make test + make test-native

[[test]]
name    = "isolation"
run     = "tools/basemap_isolation_check.loft"   # the S0 route-byte-identical + frozen-source assertions
targets = ["interpret"]
```

`loft check` then = build `native` + `html`, run the 4 emitters + wasm + standalone assets (only the stale
ones), run the kernel suites (interpret+native, cached) + the isolation gate — one exit code.

## What it replaces vs what stays

- **Replaced:** `browser/build.mjs` orchestration (→ assets), the un-incremental emit re-runs, the split
  `make test` / `test-native` / `test-wasm` (→ `[[test]]` + `loft check`), the manual wasm-rlib `make` step
  (→ Slice 1 auto-build). `browser/build-standalone.mjs` stays as a script but becomes a fingerprinted asset.
- **Stays (for now):** the **headless-Chromium gates** (`browser_app_test.sh`, `standalone_app_test.sh`,
  `client_*_test.sh`) — @PLN100 has no `html`/`wasi` test backend (reported skipped, not passed), and they
  need a browser + node, no loft backend. `make install` (native binary → `~/.local`) and `browser/serve.mjs`
  also stay. The `Makefile` becomes a **thin wrapper**: `make build`→`loft build`, `make test`→`loft check`.

## Gaps / caveats (honest — and one is loft feedback)

1. **Multi-entry vs `[build.target]` (the real gap).** @PLN100's targets are *shapes of one project entry*
   (`loft build path.loft` overrides it). Routing has **different entries per shape** — `server/server.loft`
   (native), `client/web_kernel.loft` (html), `client/kernel.loft` (wasi). So we can't say "the `html` target
   builds `web_kernel.loft`" in `[build.target]` — the entry isn't a target field. Workaround: drive each
   build output through a `[[build.asset]]` whose `run` names its own entry + shape (as above). **Feedback for
   loft:** a `[build.target.<name>] entry = "…"` field would let a multi-program app declare targets directly
   (file on `loft-lang/loft`).
2. **stdout → file.** The `emit_*.loft` print to stdout; assets produce *files*. Two options: a shell `run`
   with `> browser/areas.txt` redirect (works today), or give each emitter an output-path arg + a loft
   text-file write, so `run` is just the `.loft` script + args (cleaner; a small emitter change).
3. **Headless gates aren't loft tests.** The Chromium/CDP gates can't be `[[test]]` (no `html` backend); they
   remain shell, invoked outside `loft check` (or as a shell `[[test]]` if @PLN100 later runs arbitrary
   commands per target).
4. **Dependency.** All of this needs @PLN100 in the **installed** `loft`. Until it releases, keep the current
   Makefile/build.mjs; this doc is the plan to cut over when it lands.

## Migration path (incremental, when @PLN100 is installed)

1. Split `browser/build.mjs` into per-output steps (`build-wasm.mjs` + the emitters already stand alone) and
   declare them as `[[build.asset]]` — keep `build.mjs` as a one-line fallback that calls `loft build`.
2. Add `[[test]]` for the kernel suites (interpret+native) + the isolation gate; wire `make test` → `loft check`.
3. Thin the `Makefile` to wrappers; keep only the Chromium gates + `install` as bespoke targets.
4. File the multi-entry `[build.target] entry` gap as loft feedback (routing is the consumer that surfaced it).

## Implemented: `loft build` → GitHub Pages

The first cut is live. Root `loft.toml` now declares two assets and `.github/workflows/pages.yml` runs one
command:

```toml
[library]
entry = "client/web_kernel.loft"          # the build phase keys ONE project entry off [library] (gap #1)

[build]
default-targets = ["html"]                # also compile-checks the browser wasm kernel

[[build.asset]]                           # wasm + presentation layers + leaflet → one self-contained page
name = "standalone"
run  = "node browser/build-standalone.mjs"
inputs = [ …index.html, build-standalone.mjs, web_kernel.loft, the two libs, the four emitters + fixtures, leaflet… ]
outputs = ["browser/standalone.html"]

[[build.asset]]                           # assemble the deployable dir
name = "pages-site"
run  = "sh -c 'mkdir -p _site && cp browser/standalone.html _site/index.html'"
inputs = ["browser/standalone.html"]
outputs = ["_site/index.html"]
```

`pages.yml` then just: build loft (pinned to `tuxedo-pln100-build-phase`) → `loft build --lib lib` →
`upload-pages-artifact _site` → `deploy-pages`. No hand-orchestrated build steps in the workflow — the
manifest is the source of truth.

**Validated against loft2's binary:**
- `loft build` ran the `standalone` asset (output missing → ran `build-standalone.mjs`), then `pages-site`
  (→ `_site/index.html`, 2.0 MB self-contained page), then compile-checked the `html` target.
- **Incremental:** a second `loft build` reported `asset standalone up to date — skipping` /
  `pages-site … skipping` — the content fingerprint works, so a warm CI cache rebuilds only what changed.

**Facts found while wiring it (feedback):**
- The project entry for shape targets is read from **`[library] entry`** (`manifest.rs:479`), not
  `[package]` — awkward for an *app* (routing isn't a library). An app-level `[package] entry` or
  `[build] entry` would read better. Combined with gap #1 (one entry, shapes of it), a multi-program app
  can't declare per-shape entries — it drives outputs through assets instead, which is what we do.
- `loft --html` auto-builds its isolated wasm rlib (Slice 1), so the Pages build needs **no `make` step**.
