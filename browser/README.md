<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Serverless browser shell (PLAN-APP Track 1)

A **no-server** browser page that fetches a whole test set (one Overpass-JSON file) and runs the
**full loft matcher in wasm** — `parse_ways → build_graph → match_route` — then draws the matched
route. This is the browser realization of `client/app_kernel.loft`; the compute + data path is the
same one proven byte-identical across interpret / native / native-wasm (`make test-wasm`).

No mmap store and no codec: the data is plain text handed to `parse_ways`. The working-set
partial-load (fetch only the tiles a route needs) is a later step, gated on loft#522; until then the
page loads one whole file.

## How it works

```
client/app_kernel.loft ──loft --native-wasm──▶ app_kernel.wasm (wasip2 component)
                       ──jco transpile───────▶ gen/ (browser ESM + core wasm)
index.html: importmap → preview2-shim (browser WASI) ; fetch(test set) → shim virtual FS
            → run.run() → capture stdout → parse polyline → draw SVG
```

The jco-transpiled component imports WASI (`wasi:cli`, `wasi:filesystem`, …); in the browser those
are the `@bytecodealliance/preview2-shim` browser build, resolved via the page's import map (no
bundler). The fetched dataset is injected into the shim's in-memory filesystem (`_setFileData`), the
route is read back off captured stdout.

## Build & run

```sh
npm --prefix browser install          # jco + preview2-shim (devDeps)
npm --prefix browser run build        # loft --native-wasm + jco transpile → browser/gen/
node browser/serve.mjs                # static server (correct application/wasm MIME) on :8099
# open http://127.0.0.1:8099/browser/
```

`LOFT_BIN` / `LOFT_ROOT` override the loft toolchain location (default `../loft`).

## Headless test

`tools/browser_app_test.sh` serves the page, drives headless Chromium over the DevTools protocol,
and asserts the in-browser route is **byte-identical** to the native reference. Requires `chromium`,
`node`, the loft toolchain, and a built `gen/`. (Snap-confined Chromium cannot start inside a
restrictive command sandbox.)

`smoke.mjs` runs the same component under Node (`node browser/smoke.mjs`) — a faster, browserless
parity check.

## What's next (Track 1d)

- Swap the SVG for a **Leaflet** base map (needs a tile source; keep attribution visible — ODbL).
- Wire the sketch UI (draw → match → redraw) and drop the WebSocket for matching.
- IndexedDB cache of the fetched block; deploy to GitHub Pages.
