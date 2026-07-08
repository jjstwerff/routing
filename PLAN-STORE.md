<!-- Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later -->
# PLAN-STORE — two loft stores, served static, read in-browser by loft-wasm

**The data architecture the browser app rides on** (supersedes PLAN-MAP's JS-baked text tiles). The
browser holds **no bespoke format**: loft's own binary **store** *is* the format; loft is the only thing
that reads/writes it; text is a temporary projection loft emits over its **native host bridge**.

## The pipeline

```
OSM dumps ──build (loft, offline)──▶ TWO binary stores          served static on GitHub Pages
                                     • layout.store  (map)       │
                                     • roads.store   (network)   ▼
                                                         browser fetch (WHOLE for now)
                                                                 │  bytes → host_input
                                                                 ▼
                                                         loft-wasm store reader
                                                          store_load → emit layer TEXT via println
                                                                 │  text → JS
                                                                 ▼
                                                         JS parse* → canvas render (map.mjs)
```

- **Two files.** `layout.store` = the drawn base map (terrain `Area`s, `Building`s + names, water/rail/
  barrier `Line`s, `Poi`s, place `Label`s). `roads.store` = the road network as `Line`s
  (`kind`=road class, `name`=label = name-or-ref, geom), DP-simplified. **The map draws from BOTH files;
  `roads.store` also *is* the routing network** used to plot routes efficiently (topology added later,
  for PLAN-EDIT).
- **Static hosting.** Both `.store` files are served directly on GitHub Pages.
- **Browser reads them.** *Whole for now*; **partial later** via loft's own `store_load_keys` /
  `store_load_range`, viewport-driven.
- **loft-wasm interprets.** A loft store-reader compiled with `loft --html` receives the store bytes over
  `host_input`, `store_load`s them, and emits the layer text over `println` — loft's established native→JS
  bridge (same channel the retired web_kernel used). **Text now; a binary wasm↔JS bridge later** for
  efficiency.
- **JS renders.** The canvas renderer (`map.mjs`) + its Carto styling / generalization / labels is
  unchanged — it parses the text loft emits.

## Invariant

There is exactly **one on-disk format** (the loft store) and **one reader/writer** (loft). Everything the
browser shows is `render(parse(loft_emit(store)))`. Density, sharding, and partial reads are all properties
of the store + loft's reader — never of a format the browser or a JS baker invents. So "make it denser /
bigger / partial" changes the store and loft's read path, not the renderer or a bespoke tile scheme.

## Steps (falsifier-first — each verifies before the next)

- **T0 — two-store builder (loft, native).** Extend `build_store.loft` into `layout.store` +
  `roads.store` over the region (areas/buildings/lines/pois/place-labels vs. road network). Round-trip:
  persist → load → verify counts. *Check:* counts survive; roads carry class+label (incl. A1 by `ref`);
  buildings carry name.
- **T1 — store→text reader (loft, native first).** A loft program that `store_load`s a file and emits the
  layer text **byte-identical to the `emit_*.loft` output**, so the renderer needs no change. *Check:*
  reader-text == emitter-text for the same data.
- **T2 — reader → wasm (the one risk).** Compile the reader with `loft --html`; in the browser feed the
  `.store` bytes via `host_input`, receive text via `println`. *Check (headless):* the wasm reader, fed the
  store file's bytes, emits the same text. **This verifies loft-wasm can load a store from host-provided
  bytes (no filesystem)** — if `store_load` is path-only in wasm, use the `host_asset_*` channel or file the
  gap on `loft-lang/loft`.
- **T3 — JS harness.** `fetch` both `.store` files → wasm reader → text → `parse*` → render. Replaces
  `bake_tiles.mjs`/`tiles.mjs`. *Check:* the region renders from the stores.
- **T4 — serve.** Ship the two `.store` files + the wasm reader + renderer on GitHub Pages. *Check:* the
  live map draws from the stores.

## Folded-in render quality (the recent feedback)

Handled in the store schema + reader text + renderer, independent of transport: **road classes** (motorway/
trunk/…/path) with Carto styling; **A1 and refs** (label = name-or-ref); **building names**; **finer curves**
(DP tolerance 3 m, not 12 m); **walking paths** (footway/path/cycleway included); **sparser street labels**
(~420 px, not 190 — one name, not ten in a row).

## Deferred (recorded)

Partial/viewport store reads (`store_load_keys`/`store_load_range`); country-scale **sharding**; the
**binary wasm↔JS bridge**; coarse **LOD** for zoomed-out views; routing topology in `roads.store` (PLAN-EDIT).
