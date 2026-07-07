<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Serverless browser shell (PLAN-APP Track 1)

A **no-server** browser page that fetches a whole test set (one Overpass-JSON file) and runs the
**full loft matcher in wasm** — `parse_ways → build_graph → match_route` — then draws the matched
route. Click the map to sketch; it re-matches on every point.

Built the **loft-native way**: the wasm comes from `loft --html` and talks to JavaScript over loft's
own `host_input()`/`println` byte channel (WEB_APPS.md §4c). **No jco, no WASI, no npm deps** — the
page instantiates the wasm with a tiny 4-import shim.

## How it works

```
client/web_kernel.loft ──loft --html──▶ (self-contained page) ──extract──▶ browser/web_kernel.wasm
index.html: fetch(web_kernel.wasm) + fetch(test set)
            → instantiate with loft_io { print, input_len, input_copy } + one stub
            → set input (sketch|profile\n<dataset>) → loft_start() → read printed route → draw SVG
```

- **Data in:** JavaScript `fetch`es the file and hands loft the bytes via the input queue
  (`host_input()`); loft has no filesystem/HTTP in the browser by design.
- **Result out:** loft `println`s the route; the page reads it off the `loft_host_print` hook.
- **Interactivity:** `loft_start` rebuilds fresh state each call, so every sketch edit is just another
  call — no re-instantiation.

## Build & run

```sh
node browser/build.mjs        # loft --html client/web_kernel.loft → browser/web_kernel.wasm
node browser/serve.mjs        # static server (correct application/wasm MIME) on :8099
# open http://127.0.0.1:8099/browser/
```

`LOFT_BIN` / `LOFT_ROOT` override the loft toolchain location (default `../loft`).

## Headless test

`tools/browser_app_test.sh` builds the wasm, serves the page, drives headless Chromium over the
DevTools protocol, and asserts the in-browser route is **byte-identical to the native reference** and
that a synthetic click re-matches. Requires `chromium`, `node`, the loft toolchain. (Snap-confined
Chromium cannot start inside a restrictive command sandbox.)

The same kernel logic is also proven headless under `wasmtime` (`--native-wasm`) by
`tools/app_headless_test.sh` (via `client/app_kernel.loft`, the file+args variant) in `make test-wasm`.

## What's next (Track 1d)

- Leaflet base map (needs a tile source; keep the © OpenStreetMap attribution visible — ODbL).
- IndexedDB cache of the fetched block for offline reload; deploy to GitHub Pages.
- Working-set streaming instead of one whole file — waits on loft#522.
