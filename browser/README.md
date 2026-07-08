<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Serverless browser shell (PLAN-APP Track 1)

A **no-server** browser page that fetches a whole test set (one Overpass-JSON file) and runs the
**full loft matcher in wasm** — `parse_ways → build_graph → match_route` — then draws the matched route on
a **Leaflet map** (OpenStreetMap base tiles). Click the map to sketch; it re-matches on every point. A
**profile selector** (cycling / walking / running / driving sub-modes) re-matches with the chosen
activity weighting.

Built the **loft-native way**: the wasm comes from `loft --html` and talks to JavaScript over loft's
own `host_input()`/`println` byte channel (WEB_APPS.md §4c). **No jco, no WASI, no npm deps** — the
page instantiates the wasm with a tiny 4-import shim.

## How it works

```
client/web_kernel.loft ──loft --html──▶ (self-contained page) ──extract──▶ browser/web_kernel.wasm
index.html: fetch(web_kernel.wasm) + fetch(test set)
            → instantiate with loft_io { print, input_len, input_copy } + one stub
            → set input (sketch|profile\n<dataset>) → loft_start() → read printed route → draw on Leaflet
```

- **Data in:** JavaScript `fetch`es the file and hands loft the bytes via the input queue
  (`host_input()`); loft has no filesystem/HTTP in the browser by design.
- **Result out:** loft `println`s the route; the page reads it off the `loft_host_print` hook.
- **Interactivity:** `loft_start` rebuilds fresh state each call, so every sketch edit is just another
  call — no re-instantiation.
- **Base map:** a **Leaflet** map with OpenStreetMap raster tiles (vendored `vendor/leaflet/`, © OSM). The
  road network is drawn from the local data as an always-on layer, so if tiles can't load — offline, throttled,
  or blocked — the map falls back to that render and the route is never on a blank canvas.
- **Fully offline:** a **service worker** (`sw.js`) caches the app shell + wasm + Leaflet; the test set is
  cached in **IndexedDB** (keyed by a dataset version). A reload with the network **entirely off** still loads
  and matches (base tiles are skipped, road network + route still draw) — verified by the gate.
- **Data freshness:** when the dataset carries an Overpass snapshot (`osm3s.timestamp_osm_base`), the footer
  shows "data as of …". Test fixtures have none; generated blocks will stamp it (PLAN-APP §11).

## Build & run

```sh
node browser/build.mjs        # loft --html client/web_kernel.loft → browser/web_kernel.wasm
node browser/serve.mjs        # static server (correct application/wasm MIME) on :8099
# open http://127.0.0.1:8099/browser/
```

`LOFT_BIN` overrides the loft binary (default: `loft` on PATH); `LOFT_ROOT` the loft source tree
(default `../loft`, for the `default/` library needed by `--html`).

## Standalone (single self-contained file)

```sh
node browser/build-standalone.mjs   # → browser/standalone.html  (or: make standalone)
# open browser/standalone.html directly — double-click / file://, no server
```

`standalone.html` inlines the wasm (base64) **and** one test set as `window.__STANDALONE`, so the whole
app is one file that runs with **no server and no network** — index.html detects the inlined assets and
skips the fetch/service-worker/IndexedDB paths. Same UI, same matcher; drop it on any static host or
share the file. Rebuild it whenever the kernel or the test set changes.

## Headless test

`tools/browser_app_test.sh` builds the wasm, serves the page, drives headless Chromium over the
DevTools protocol, and asserts the in-browser route is **byte-identical to the native reference** and
that a synthetic click re-matches. Requires `chromium`, `node`, the loft toolchain. (Snap-confined
Chromium cannot start inside a restrictive command sandbox.)

The same kernel logic is also proven headless under `wasmtime` (`--native-wasm`) by
`tools/app_headless_test.sh` (via `client/app_kernel.loft`, the file+args variant) in `make test-wasm`.

`tools/standalone_app_test.sh` (`make test-standalone`) proves the single-file `standalone.html` runs
over `file://` with the network emulated **fully off**, byte-identical to the native reference.

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` builds the single-file `standalone.html` and publishes it as the Pages site
index (one self-contained file → no asset-path / MIME / CORS concerns; OSM tiles load at run time). It runs
on push to `main`; the live URL appears in the workflow's `deploy` job.

## What's next

- **Track 1d done:** Leaflet base map ✓, GitHub Pages deploy ✓, data-freshness readout ✓.
- **Working-set streaming** instead of one whole file — now unblocked by loft's `store_load`/`store_load_key`
  (loft#522 landed); JS does the HTTP Range fetches and feeds loft the bytes (PLAN-APP Track 2).
- **OSM tile policy:** the public `tile.openstreetmap.org` service is fine for a low-traffic demo but forbids
  heavy use / app distribution — swap in own/provider tiles before real scale.
