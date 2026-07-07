# PLAN-APP — the standalone Western-Europe app (serverless, working-set)

The capstone: a **browser app with no server** that routes over **Western Europe** by fetching **only
the blocks and tiles it needs** for the current view/route — never the whole dataset. Compute runs in
wasm (the PLAN-MATCH matcher); data is open blocks hosted on GitHub, read on demand. This refines
**PLAN-BROWSER** (esp. Phase 8) with the post-8.2 reality — `store_persist_bind` (mmap) does **not**
work in wasm, so data is loaded by **fetch + decode (a byte codec)**, not by mapping a store.

Rolled out in three steps that each force more of the same architecture: **south-Overijssel → Benelux
→ all of Western Europe.**

---

## 1. The one principle — read the working set, never everything

Western Europe is ~6–10 GB (PLAN-TILES). A phone can't hold or download that. So the app's spine is:
**resolve the small set of tiles the current route/view needs → fetch just those bytes → decode →
match.** Everything below serves that. The only thing ever loaded in full is a tiny **top index**.

The corridor the matcher needs is a thin tube around the sketch (PLAN-MATCH); geographically that is a
handful of ~2 km tiles even for a long route — kilobytes to a few MB, not gigabytes.

---

## 2. Data hierarchy — index → block → tile → byte range

```
top index            (one small file, always loaded)
  └─ block            (~0.5 GB hosted file; a country or split — PLAN-TILES 0.5 GB cap)
       └─ directory   (tile key → [byte offset, length] within the block)
            └─ tile    (~2 km cell: roads/steps/heights/trail-ids — self-contained)
```

- **Top index**: geographic bbox → which block(s) cover it + each block's URL and directory location.
  Small (one row per block; WE ≈ 12–20 blocks). Loaded once at startup.
- **Block**: a hosted file (GitHub Release asset). Begins with (or points to) its **directory** — a
  compact `tile key → offset,len` map — followed by the tile blobs.
- **Tile**: self-contained (PLAN-TILES): its ways/steps/heights, boundary nodes shared bit-identically
  with neighbours so co-loaded tiles connect with no fuzzy matching, no cross-tile references.

This is essentially **routing-specific PMTiles** (PLAN-BROWSER's own framing): one range-addressable
file, a directory, working-set reads.

---

## 3. The read path (components, in order)

1. **Resolve** — from the map view / sketch bbox, compute the covering tile keys (+ a one-tile ring),
   look them up in the top index → block(s), and in each block's directory → byte ranges.
2. **Fetch** — **HTTP Range** reads of exactly those tile blobs (loft-libs-net **#517** — range +
   headers + size, native proven, browser `fetch()` bridge implemented). First fetch of a block also
   range-reads its directory.
3. **Decode** — a **byte codec** turns fetched tile bytes into in-memory `hash<TTile[tkey]>` /
   `vector<Way>`. This is the piece 8.2 forces: **no mmap in wasm**, so the tile format is read by
   explicit decode, not `store_persist_bind`. Shared native+wasm (PLAN-BROWSER 8.3 `codec.loft`).
4. **Cache** — decoded tiles (and raw blobs) in **IndexedDB**, keyed by tile key + dataset version, so
   revisits and offline use need no refetch. LRU eviction bounds storage.
5. **Match** — `build_graph` over the working-set ways → the PLAN-MATCH escalation matcher. Boundary
   nodes make adjacent tiles connect automatically.
6. **Stitch across blocks** — a route/corridor crossing a block border pulls tiles from both blocks;
   shared border nodes join them. The matcher never knows a border was crossed.

Everything but the top index is lazy and bounded by the working set.

---

## 4. Compute — the matcher in wasm

- The kernel already runs **byte-identical in wasm** (PLAN-BROWSER 0.1, verified). The matcher is
  PLAN-MATCH (escalation ladder + quality gate); its instrumentation (§7 there) is in.
- The **orchestration currently in `server.loft`** (`match_for`: accumulate / widen / tile-vs-fallback)
  **moves into wasm or JS** — it's the one substantial port from the server app.
- Invocation model (PLAN-BROWSER 0.2): a **resident wasm instance** with callable exports for
  incremental match, else rebuild-per-edit from the cached working set (still sub-second). Async data
  fetch suspends via the #517 asyncify bridge.

---

## 5. Staged rollout — each step forces more of the architecture

| step | data | what it exercises | what it defers |
|---|---|---|---|
| **1 · south-Overijssel** | one **21 MB** block | compute+data core in-browser: **whole-file fetch** (same-origin GitHub Pages), decode, match, draw | directory, range reads, multi-block, cross-origin |
| **2 · Benelux** | ~2–3 × **0.5 GB** blocks (Releases) | **the real serverless spine**: top index, per-block **directory**, **Range** working-set fetch, cross-origin **CORS**, IndexedDB cache | cross-*block* corridor stitching at scale |
| **3 · Western Europe** | ~12–20 blocks (~6–10 GB) | same spine at scale: bigger top index, **cross-block stitching**, **block-level LRU** eviction | — (this is the target) |

Step 1 is a straight-line proof (no directory/range). **Step 2 is the forcing function** — it builds
every serverless piece Western Europe needs, at a debuggable ~1 GB. Step 3 is "more blocks," not new
architecture. Generation reuses the existing pipeline (`osmium → geojsonseq → Overpass-JSON → gen6`)
per split; Geofabrik extracts per country.

---

## 6. Hosting & distribution

- **App** (html + wasm + JS): **GitHub Pages** — CDN, same-origin, Range-capable.
- **Blocks**: **GitHub Releases** (≤2 GB/asset, unmetered bandwidth). Step-1's 21 MB can sit in the
  Pages repo (same-origin, sidesteps CORS); ≥Step 2 uses Releases → **verify CDN CORS exposes
  `Content-Range`/`Content-Length`** for the browser range path (the #517 bridge is built for this).
- **Early access**: open repo, **unlisted app URL** shared with the selected group — no login wall;
  public launch = publicize the same URL.

---

## 7. Making it truly open — the loft model

Mirror how loft itself is run: a copyleft license with SPDX headers, clear attribution, contributor
docs, and public issue/plan tracking. Concrete artifacts to add:

1. **License — code: `LGPL-3.0-or-later` (same as loft and loft-libs), data: `ODbL-1.0`.**
   - `LICENSE` (LGPL-3.0 text) for the code; **SPDX headers** on our sources — the loft convention:
     ```
     // Copyright (c) 2026 Jurjen Stellingwerff
     // SPDX-License-Identifier: LGPL-3.0-or-later
     ```
   - `LICENSE.data` (ODbL-1.0) covering the generated `.tiles` blocks — share-alike; can't be
     relicensed. LGPL for code composes cleanly with the LGPL loft-libs.
2. **Attribution — `ATTRIBUTION.md` / `NOTICE`** crediting **OpenStreetMap contributors (ODbL)**, the
   **terrain source** (terrarium / SRTM et al.), and **waymarked-trails** (OSM). The same credit line is
   **visible in-app** (footer/about) — an ODbL requirement, not optional.
3. **Contributor docs — `CONTRIBUTING.md`** (how to build: `make build`/`make test`, the SDKROOT note,
   sibling `../loft`; coding style; **DCO sign-off** or CLA choice), **`CODE_OF_CONDUCT.md`**, and a
   `README.md` that states what it is, the dual license, data provenance, and a quickstart.
4. **Issues & planning like loft** — public GitHub **issues** for bugs/features (as we already do
   upstream: #511/#513/#517), **issue templates** (bug / feature / data-quality) and **labels**. Keep
   the **`PLAN-*.md` design docs in-repo** as the plan of record; optionally adopt loft's numbered,
   status-labelled plan convention (`status: future|active|parked`) if planning grows.
5. **CI** — build + `make test` green on PRs (as loft-libs-net gates), so external contributions are
   checkable; a data-regeneration smoke on the pipeline.
6. **Data provenance & reproducibility** — document the generation pipeline (`osmium → geojsonseq →
   Overpass-JSON → gen6`) so anyone can rebuild the blocks from public OSM — which *is* the ODbL
   "make the derivative database available" obligation, satisfied by open tooling.

Net: LGPL code + ODbL data + visible attribution + open pipeline + public issues/plans = a repo that is
open in the same shape as loft, and airtight on OSM licensing.

---

## 8. Buildable now vs. needs the browser toolchain

- **Buildable + provable here (headless, wasmtime):** the whole data-access core — **byte codec**,
  **block directory**, **working-set resolver**, whole-file *and* range loaders, decode → `build_graph`
  → match. A wasm entry that loads south-Overijssel from a **fetch-friendly file (not the mmap store)**
  and matches a route under wasmtime retires the last core unknown (compute+data, no server, no mmap).
- **Needs node + jco + a browser (not in this environment):** the actual page — transpile the kernel to
  a browser wasm module, wire the fetch/asyncify bridge, IndexedDB, and the Leaflet UI to call wasm
  instead of the WebSocket. Mechanical on a node-equipped machine; can't be produced/run here.

So the plan: **build and prove the data-access core headlessly now** (the substantive risk), then
package the browser shell where node/jco/a browser exist.

---

## 9. Open questions

- **Directory placement** — header-embedded per block, or a sidecar directory file range-read first?
  (Sidecar = one extra small fetch; embedded = one fetch, needs a fixed header.)
- **Codec format** — reuse the compact binary tile layout via an explicit decoder, or a purpose-built
  wire format? (Binary beats the 34 MB text `.ways` projection.)
- **Block granularity vs. the 0.5 GB cap** — country splits vs. a uniform grid of blocks; affects top
  index size and cross-block frequency.
- **Cross-block corridor** — resolve per-tile against the top index (a tile knows its block), so a
  corridor spanning two blocks just fetches from both; confirm the resolver handles it transparently.
- **Cache/versioning** — dataset version in the IndexedDB key so a block refresh invalidates cleanly.

Related: **PLAN-BROWSER** (serverless phases; this refines its Phase 8 post-8.2), **PLAN-TILES**
(block/tile format, directory, boundary nodes, 0.5 GB cap), **PLAN-MATCH** (the wasm matcher),
**PLAN-ROUTING** (the get-me-there fork), loft-libs-net **#517** (the range-fetch stack).

---

## 10. Concrete steps (small, ordered, each with a Check)

Four tracks. **O** and **C** run **now** in this repo/env; **1–3** need node + jco + a browser
(elsewhere). Do O and C first — C retires the last core unknown without a browser.

### Track O — open-project scaffolding (no code deps)
- **O1** `LICENSE` = LGPL-3.0-or-later text. *Check:* file present.
- **O2** `LICENSE.data` = ODbL-1.0 text + one line: generated `.tiles`/blocks are ODbL. *Check:* present.
- **O3** SPDX + copyright header on our own `.loft` sources (kernel, server, tools). *Check:*
  `grep -L SPDX-License` lists none of our sources.
- **O4** `ATTRIBUTION.md` (OSM/ODbL + terrain + trails) **and** the in-app credit line in `index.html`.
  *Check:* running app footer shows "© OpenStreetMap contributors".
- **O5** `README.md` (what/why, dual license, provenance, quickstart) + `CONTRIBUTING.md` (build/test,
  DCO sign-off) + `CODE_OF_CONDUCT.md`. *Check:* README quickstart runs clean.
- **O6** `.github/ISSUE_TEMPLATE/` (bug / feature / data-quality) + label list. *Check:* templates
  render on "New issue".

### Track C — headless data-access core (buildable + provable under wasmtime, now)
- **C1** Spec + `codec.loft` **writer**: a range-addressable block = header + tile **directory**
  (`tkey → offset,len`) + tile blobs (compact binary, no mmap store). *Check:* encode south-Overijssel →
  `soverijssel.rtb`; size sane vs the 21 MB `.tiles`.
- **C2** `codec.loft` **decoder** (whole file): bytes → `vector<Way>`, no `store_persist_bind`.
  *Check:* native decode gives the same 229,117 ways as the store read.
- **C3** **Prove under wasm:** a wasm entry reads `soverijssel.rtb` (whole, via `--dir`), decodes,
  matches a route. *Check:* wasmtime match == native match for the same route (parity), **no mmap**.
- **C4** **Directory reads:** `read_tile(block, tkey)` seeks via the directory instead of decoding all.
  *Check:* `read_tile` for sample keys == the tiles from a full decode.
- **C5** **Working-set resolver:** `pts + margin → covering tile keys` (cell-tube, PLAN-MATCH). *Check:*
  the 40-pt route's resolved tiles' union covers the corridor (== whole-block match result).
- **C6** **Range loader (native, #517):** fetch directory + working-set blobs from a hosted `.rtb`,
  decode, match. *Check:* against a local Range server, match == whole-file match **and** bytes
  fetched ≪ file size.

### Track 1 — south-Overijssel browser app (needs node/jco/browser)
- **1a** Transpile kernel + match entry to a browser wasm module (jco / wasm-bindgen). *Check:* minimal
  HTML calls it, returns a match for a hardcoded route.
- **1b** JS: fetch the whole `soverijssel.rtb` once → wasm; cache raw+decoded in IndexedDB. *Check:*
  offline reload matches with **no network**.
- **1c** Rewire the Leaflet UI: draw → wasm match → draw detailed; drop the WebSocket for matching.
  *Check:* sketch → matched route drawn with **no server running**.
- **1d** Deploy to GitHub Pages (unlisted URL). *Check:* open on a phone, route works, attribution shows.

### Track 2 — Benelux (multi-block, working-set range reads)
- **2a** Generate Benelux blocks (NL×2, BE, LU) via the pipeline → `.rtb` each. *Check:* all decode;
  counts sane; total ~1 GB.
- **2b** Build the **top index** (bbox → block URL + directory offset). *Check:* a point in each country
  resolves to the right block.
- **2c** Host blocks on Releases; verify **cross-origin CORS + Range** fetch. *Check:* browser
  range-fetches a tile from a Release asset (206, correct bytes).
- **2d** Browser working-set loader: resolve → range-fetch only needed tiles → decode → cache → match.
  *Check:* a route near Amsterdam fetches a few MB (not GB) and matches.
- **2e** Cross-block stitch: a route crossing the NL/BE border. *Check:* matches through the border,
  no gap.

### Track 3 — Western Europe (scale)
- **3a** Generate all WE blocks (Geofabrik extracts, 0.5 GB cap per split). *Check:* N blocks, ~6–10 GB,
  all decode.
- **3b** Block-level **LRU eviction** + scaled top index. *Check:* routing across far regions bounds
  memory/storage.
- **3c** Public launch: publicize the URL; dataset downloads offered under ODbL. *Check:* a cold visitor
  routes anywhere in WE.

**Critical path:** O1–O4 (openness) ∥ C1→C2→C3 (prove the codec in wasm) → C4→C5→C6 (working-set +
range) → Track 1 (browser shell) → Track 2 (the real serverless spine) → Track 3 (scale).
