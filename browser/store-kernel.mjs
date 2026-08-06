// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// Host driver for the loft --html base-map kernel (client/web_basemap_kernel.loft, extracted to
// store-kernel.wasm): lets a JS renderer drive it as `runKernel(blob) -> Promise<text>`. Reuses the
// loft --html shell's AsyncifyCtrl + loft_io imports verbatim — store_load_url_trusted's fetch is bridged
// to JS fetch() via asyncify.
//
// LOFT OWNS THE LOOP (PLAN-PERF §0 step 5). `loft_start` is called ONCE and never returns: the kernel
// loops on host_input() and frame_yield()s while idle, so JS pushes commands into the queue and reads
// responses back. This is the model BROWSER_INTEROP.md prescribes; the one-shot "loft_start per request"
// form it replaces is the one loft explicitly rejected, and it was why every click paid a fresh store
// decode + a full rebuild.
//
// Two consequences the code below has to honour:
//   * `loft_start` returning can no longer mean "the command is done" — it never returns. The kernel
//     terminates each response with a bare `#EOR` line and we resolve on that.
//   * a resume must know WHAT suspended us. loft_host_http_get's rewind path returns 0xFFFFFFFF when
//     httpBytes is still null, so a yield-driven resume landing mid-fetch would make store_load fail
//     spuriously. `waiting` tags the reason; only the matching resumer fires.

// The async→sync bridge (verbatim from the loft --html shell). A suspend import unwinds the whole wasm
// stack back to the JS event loop; the fetch's .then() calls resume() to rewind and continue past the yield.
function AsyncifyCtrl(instance) {
  const DATA_ADDR = (instance.exports.__heap_base?.value || 65536);
  const STACK_SIZE = 16384;
  const E = instance.exports;
  this.sleeping = false; this.exports = E;
  let savedTop = DATA_ADDR + 8;
  const STATE_REWINDING = 2;
  const setStruct = (cur, end) => { const mem = new Int32Array(E.memory.buffer); mem[DATA_ADDR >> 2] = cur; mem[(DATA_ADDR + 4) >> 2] = end; };
  const curPtr = () => new Int32Array(E.memory.buffer)[DATA_ADDR >> 2];
  this.start = function (fn) { this.sleeping = false; E[fn](); if (this.sleeping) { savedTop = curPtr(); E.asyncify_stop_unwind(); } };
  this.resume = function (fn) { if (!this.sleeping) return false; this.sleeping = false; setStruct(savedTop, DATA_ADDR + 8 + STACK_SIZE); E.asyncify_start_rewind(DATA_ADDR); E[fn](); if (this.sleeping) { savedTop = curPtr(); E.asyncify_stop_unwind(); } return true; };
  this.suspend = function () { if (E.asyncify_get_state() === STATE_REWINDING) { E.asyncify_stop_rewind(); return; } this.sleeping = true; setStruct(DATA_ADDR + 8, DATA_ADDR + 8 + STACK_SIZE); E.asyncify_start_unwind(DATA_ADDR); };
}

// Instantiate the kernel wasm once and return { runKernel, stats }. Calls are serialized by the caller
// (await one before the next) — the kernel reads one blob per loop pass.
const EOR = '#EOR';   // must match client/web_basemap_kernel.loft's terminator

export async function createKernel(wasmUrl) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const inQ = [];
  const ctrl = { ac: null, httpBytes: null, httpTotal: -1 };
  const exposed = new Map();   // tag -> { storeBase, rec, pos, typeId, desc } from expose() (step 9)
  let mem, outBuf = '', resolveRun = null, started = false, starts = 0, commands = 0, storeLoads = 0;
  // SIDECARS ARE NOT STORE BODIES, and conflating them made the session invariant report a re-decode that
  // was not happening. `storeLoads` is the load-bearing count ("each store decoded ONCE"), but every
  // command naming a store also fetches its ~1.3 kB `.dschema`, and once blocks became PAGED the bodies
  // stopped coming through this bridge at all — so the whole count was sidecars, and the ❌ fired on both
  // sides of every comparison. Counted apart, `storeLoads` means what it says again.
  let sidecarLoads = 0, sidecarHits = 0;
  // url -> bytes, sidecars only. See loft_host_http_get for why this is safe and why it stops there.
  const schemaCache = new Map();
  // PLAN-SCALE C1b: a working-set read is only a working set if you can SEE what it fetched.
  let rangeReads = 0, rangeBytes = 0, rangeAsked = 0;
  // Per STORE, not just the session total. A gate that says "48% of a 222.4 MB block" has to be able to
  // name which block, and the session total silently stopped being able to: once the base map moved to
  // the app's own origin its pages joined the same counter, and a roads-block budget started failing on
  // base-map bytes. The url is right here, so attribution costs one Map.
  const perStore = new Map();
  // Whole-file loads by store filename — the attribution half of `storeLoads` (see loft_host_http_get).
  const wholeLoads = new Map();
  // ⚠ THE LIST IS CAPPED FOR REPORTING (4 entries), SO THE COUNT IS SEPARATE. A caller asking "did any
  // read fail during this command" got `rangeFails.length`, which saturates at the cap and then stops
  // moving — the fifth failure onward was invisible to exactly the check that cares most.
  const rangeFails = [];
  let rangeFailed = 0;
  // ⚠ A PREFETCH BUFFER, NOT A CACHE — the distinction the sidecar comment above turns on. A cache
  // RETAINS, which would hold a second copy of a 20 MB image in JS beside wasm's. This is DRAINED: each
  // range is deleted the moment loft consumes it, so peak JS memory is the in-flight batch and not the
  // store. Filled by `__perfHooks.prefetch`, which issues the whole batch CONCURRENTLY — that is the
  // entire point, because the reads are latency-bound (a 64 kB range costs the same as one byte, so 764
  // serial round trips are ~20 s of pure waiting). See docs/prefetch-index-design.md.
  // ⚠ KEYED BY PAGE NUMBER, NOT BY (off, len). The first version keyed on the exact range and worked
  // only because the A/B replayed a capture verbatim. Driven from the index we know PAGES, and loft asks
  // for 64 kB most of the time but also 128 kB and 192 kB spans — every one of those would have missed.
  // Page-granular storage serves any request shape that its pages cover, which is what the page-set model
  // said all along.
  const prefetched = new Map();          // url -> Map<pageNo, Uint8Array>
  // ⚠ PAGES ARE RETAINED AFTER CONSUME NOW, UP TO A CAP — the buffer used to DRAIN, and that was the
  // single largest cost left in a session. Measured on one Luxembourg screen: of 722 reads that missed
  // the buffer, 663 were pages this session had already fetched and then dropped, because the ring reads
  // the same ground the view just read. Dropping them made the dedup refuse to re-buy them (rightly) and
  // the read went serial (expensively).
  //
  // The drain existed to bound memory (design §5.4), which a CAP does directly: hold pages until
  // `PFCAP` bytes, then evict the oldest. An evicted page becomes buyable again — eviction removes it
  // from the bag, and the bag IS the record of what we hold, so `prefetch` skipping what is in the bag
  // is the whole dedup. Nothing else has to remember anything.
  // ⚠ THE CAP FOLLOWS THE DEVICE, because the whole point is that a phone cannot afford what a laptop
  // can. Measured live on Amsterdam (working set 172.2 MB), it is worth real time and real memory:
  //
  //     cap 64 MB   view 1.19x  settle 1.48x   JS heap 239.9 MB
  //     cap 128 MB  view 1.71x  settle 2.41x   JS heap 294.9 MB   (beside 202.6 MB of wasm)
  //
  // ⚠ AND THE SIGNAL IS THE HEAP CEILING, NOT `navigator.deviceMemory`. deviceMemory is specified to be
  // capped at 8 and rounded to a power of two; this Chromium returns **32**, so a formula scaled by it
  // silently lands on the maximum on any machine that over-reports. `jsHeapSizeLimit` is the browser's
  // own ceiling for the tab and it is exactly the budget this buffer spends — the buffer IS JS heap.
  // 15% of it leaves room for the map, the index and everything else that is not this buffer: ~128 MB on
  // a desktop's 4.4 GB ceiling, ~77 MB where a phone reports 512 MB. Where no engine reports one
  // (Firefox, Safari), fall back to the conservative middle rather than the maximum.
  //
  // Settable before load so a gate can force EVICTION on a small session — the path is otherwise
  // untested on any camera that fits under the cap, and untested eviction is how a buffer starts
  // returning pages it no longer holds.
  // The cap is the DEVICE's to decide (browser/device.mjs) — one tier answers for the buffer, the
  // off-screen ring and the drawn detail together, because they spend the same machine. `__prefetchCap`
  // still overrides, so a gate can force eviction on a session that would otherwise fit.
  const PFCAP = (typeof window !== 'undefined' && window.__prefetchCap)
    || (typeof window !== 'undefined' && window.__deviceCapBytes)
    || 48 * 1024 * 1024;
  let prefetchHeldBytes = 0, prefetchPeakBytes = 0, prefetchEvicted = 0, prefetchMaxBatchBytes = 0;
  let prefetchDownloadBytes = 0;         // what the BATCHES cost the wire, apart from what was read
  let persistHits = 0;                   // reads answered off the device, with no network at all
  // Set while a route pack is being built, so those pages are written PINNED rather than incidental.
  let prefetchPackId = null;
  let prefetchHits = 0, prefetchMiss = 0, prefetchBytes = 0;
  let prefetchMissDrained = 0, prefetchMissUnknown = 0;
  const prefetchTotals = new Map();
  const PFPAGE = 65536;
  // Which pages the cap threw away, per store — so a later miss can say WHY (evicted, or never named).
  const evictedPages = new Map();        // url -> Set<pageNo>
  // ⚠ A SECOND TIER, BEHIND THE BUFFER AND IN FRONT OF THE WIRE. The buffer above dies with the tab and
  // the host only allows caching for ten minutes (`max-age=600`, measured live) on data that is immutable
  // for the life of a dataset. `page-cache.mjs` keeps pages across sessions, keyed by the block's sha256
  // so a regenerated block cannot be served from an old one. Set by the app, which is what knows the
  // hashes; absent, every lookup below misses and this file behaves exactly as it did.
  let shaOf = () => null;                // url -> sha256, from coverage.json
  let sizeOf = () => 0;                  // url -> byte length, likewise — see the size probe below
  let persist = null;                    // the page-cache module, or null when the app did not wire it
  // Every page this session has bought, per store — kept across eviction ON PURPOSE (see `prefetch`).
  const fetchedOnce = new Map();         // url -> Set<pageNo>
  // Oldest-first eviction. A Map iterates in insertion order, so the first key is the oldest page held;
  // that is FIFO rather than LRU, and it matches how these are used — a page is read shortly after the
  // batch that fetched it, and the ring moves outward, so age tracks distance from the screen.
  // ⚠ NEVER EVICT THE BATCH THAT IS STILL BEING FETCHED. The batch is filled immediately before the
  // kernel reads it, so a page from it is the single most certain future read in the session — and
  // oldest-first eviction targets exactly the pages that arrived first, i.e. that same batch. Measured at
  // a 16 MB cap on a ~50 MB batch: the view got SLOWER than not prefetching at all (0.82x), because it
  // paid for pages that were thrown away before it could read them. When one batch exceeds the cap the
  // cap is exceeded until it is consumed, and `prefetchPeakBytes` says so rather than hiding it.
  let inFlight = null;                   // { key, pages: Set<pageNo> } while a batch is filling
  const evict = () => {
    if (prefetchHeldBytes <= PFCAP) return;
    for (const [u, m] of prefetched) {
      for (const [pno, pg] of m) {
        if (prefetchHeldBytes <= PFCAP) return;
        if (inFlight && inFlight.key === u && inFlight.pages.has(pno)) continue;
        m.delete(pno);
        prefetchHeldBytes -= pg.length;
        prefetchEvicted++;
        if (!evictedPages.has(u)) evictedPages.set(u, new Set());
        evictedPages.get(u).add(pno);
      }
    }
  };
  let waiting = null;   // why loft is suspended: 'fetch' | 'yield' | null — see the header note
  let onLine = null, scanned = 0, deliveries = 0;   // the in-flight command's line sink — see `drain`

  // Hand the lines loft has flushed SO FAR to the in-flight command's `onLine`, and only then.
  //
  // This is what makes a response arrive progressively instead of all at once (PLAN-PERF §6b(2)): the
  // kernel prints `STRETCH i;…` and immediately frame_yield()s, so every stretch is flushed at a yield
  // point and reaches JS while the match is still running.
  //
  // Three properties it must have, each earned:
  //   * OPT-IN. A `view` flushes ~400 KB and wants none of this; with no `onLine` the scan never runs, so
  //     the view path pays exactly what it paid before. This is why the header's "never scan per print"
  //     rule survives — the scan is per YIELD, and only for a caller that asked.
  //   * NON-DESTRUCTIVE. `scanned` is a cursor, not a consume: `outBuf` keeps every line, so the promise
  //     still resolves with the complete text and the ROUTE/SUMMARY parse downstream is untouched.
  //   * ONLY AT YIELDS. `pump` deliberately does NOT call this. Draining there would hand the tail of a
  //     finished response to `onLine` in one burst, and `deliveries` — the gate's observable — would count
  //     that burst as streaming. Every stretch is followed by a frame_yield(), so nothing is missed.
  const drain = () => {
    if (!onLine) return;
    let nl, sent = 0;
    while ((nl = outBuf.indexOf('\n', scanned)) >= 0) {
      const line = outBuf.slice(scanned, nl);
      scanned = nl + 1;
      sent++;
      onLine(line);
    }
    if (sent) deliveries++;
  };

  // Resolve the in-flight command once its terminator lands. Checked whenever loft suspends (it prints
  // the whole response, then loops and yields), never per print — that would scan 29k lines a view.
  const pump = () => {
    if (!resolveRun) return;
    const i = outBuf.indexOf(EOR);
    if (i < 0) return;
    const out = outBuf.slice(0, i);
    outBuf = outBuf.slice(i + EOR.length).replace(/^\n/, '');
    scanned = 0;                                    // the cursor indexed the response just consumed
    const done = resolveRun; resolveRun = null; onLine = null; done(out);
  };
  // Continue loft past whatever it is suspended on. `why` guards the race: a yield-driven resume must
  // not land inside a pending fetch's rewind (which would read httpBytes === null as a load failure).
  const wake = (why) => { if (waiting !== why) return; waiting = null; ctrl.ac.resume('loft_start'); pump(); };

  const imports = {
    loft_io: {
      loft_host_print: (ptr, len) => { outBuf += dec.decode(new Uint8Array(mem.buffer, ptr, len)); },
      loft_host_input_len: () => (inQ.length ? inQ[0].length : 0),
      loft_host_input_copy: (ptr) => { const b = inQ.shift(); if (b) new Uint8Array(mem.buffer, ptr, b.length).set(b); },
      loft_host_output: (/* ptr, len */) => {},               // structured out — unused by this kernel
      loft_host_http_get: (ptr, len) => {
        if (ctrl.ac && ctrl.ac.exports.asyncify_get_state() === 2) { ctrl.ac.suspend(); return ctrl.httpBytes ? ctrl.httpBytes.length : 0xFFFFFFFF; }
        const url = dec.decode(new Uint8Array(mem.buffer, ptr, len));
        // Counted on the UNWIND pass only — the rewind above returns early.
        // WHICH store, not just how many. `storeLoads` is the session's load-bearing invariant ("each
        // store loaded ONCE"), and when it climbs the total says nothing about WHY: five whole-file loads
        // is fine if they are five different stores and a defect if they are one store five times. Range
        // reads have had per-store attribution since the roads budget failed on base-map bytes; this is
        // the same rule applied to the other counter, and it is what tells a re-decode from a wider set.
        const wk = url.split('?')[0].split('/').pop() || url;
        const isSidecar = wk.endsWith('.dschema');
        // A SIDECAR CANNOT CHANGE UNDER A SESSION, so fetch each one once.
        //
        // Every command naming a store re-fetched its `.dschema`: 15 requests for 2 distinct files in a
        // 109-command profile, and the ring made it worse by issuing eight more views per view. The
        // content is immutable for the session — it describes the layout the block was WRITTEN with, and
        // loft#705 refuses the store outright if that ever disagrees — so a second fetch can only return
        // the bytes already held.
        //
        // A hit answers SYNCHRONOUSLY: return the length and let `..._get_copy` take the bytes, with no
        // fetch, no asyncify unwind and no round trip. That is the same shape as the no-asyncify path,
        // and it is safe precisely because nothing suspends — there is no rewind to get wrong.
        //
        // ⚠ SIDECARS ONLY, deliberately. The same cache over a store BODY would hold a 20 MB image in JS
        // beside the copy already in wasm memory, which is the opposite of what a paged read is for.
        if (isSidecar) {
          const hit = schemaCache.get(url);
          if (hit) { sidecarHits++; ctrl.httpBytes = hit; return hit.length; }
        }
        // Counted on the UNWIND pass only — the rewind above returns early.
        // WHICH store, not just how many. `storeLoads` is the session's load-bearing invariant ("each
        // store loaded ONCE"), and when it climbs the total says nothing about WHY: five whole-file loads
        // is fine if they are five different stores and a defect if they are one store five times. Range
        // reads have had per-store attribution since the roads budget failed on base-map bytes; this is
        // the same rule applied to the other counter, and it is what tells a re-decode from a wider set.
        wholeLoads.set(wk, (wholeLoads.get(wk) || 0) + 1);
        if (isSidecar) sidecarLoads++; else storeLoads++;
        ctrl.httpBytes = null;
        const back = (b) => { ctrl.httpBytes = b; if (isSidecar && b) schemaCache.set(url, b); wake('fetch'); };
        // ⚠ THE SIDECAR MUST SURVIVE THE SESSION TOO, or a saved route is unreadable however many of its
        // PAGES are on the device. `.dschema` is what lets `store_load_keys` open a block at all, it comes
        // through this whole-file arm rather than the range one, and its in-memory cache dies with the
        // tab. Measured: with 862 pages served from disk and zero misses, the offline map still drew
        // NOTHING — because the schema could not be fetched and no store could be opened.
        const fromDisk = (persist && isSidecar) ? persist.getBlob('sidecar', url) : Promise.resolve(null);
        fromDisk.then((hit) => {
          if (hit) { persistHits++; back(hit); return; }
          fetch(url).then(async (res) => {
            const b = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
            if (b && persist && isSidecar) persist.putBlob('sidecar', url, b).catch(() => {});
            back(b);
          }).catch(() => back(null));
        }).catch(() => back(null));
        if (ctrl.ac) { waiting = 'fetch'; ctrl.ac.suspend(); }
        return 0;
      },
      loft_host_http_get_copy: (ptr) => { if (ctrl.httpBytes) new Uint8Array(mem.buffer, ptr, ctrl.httpBytes.length).set(ctrl.httpBytes); },
      // loft#678 — the RANGE arm of the same bridge, behind the working-set loaders
      // (store_load_key/keys/range): one `Range: bytes=off-(off+len-1)` GET instead of a whole file, so a
      // match reads the few pages its corridor touches out of a hosted block (PLAN-SCALE C1b). Mirrors
      // loft's own shim (doc/loft-gl-wasm.js) — this app drives the wasm from its OWN host, so an import
      // loft's page provides has to exist here too or the module will not instantiate.
      //
      // Two-phase asyncify, exactly like http_get above: the REWIND pass returns the stashed length, the
      // UNWIND pass starts the fetch and suspends. One response stash is safe because a suspend bridges a
      // SYNCHRONOUS loft call — a second request cannot begin before this one has rewound.
      // `off`/`n` arrive as f64 (exact below 2^53) — a u64 would cross as BigInt and trap in the
      // arithmetic below.
      loft_host_http_range: (ptr, len, off, n) => {
        if (ctrl.ac && ctrl.ac.exports.asyncify_get_state() === 2) { ctrl.ac.suspend(); return ctrl.httpBytes ? ctrl.httpBytes.length : 0xFFFFFFFF; }
        if (!ctrl.ac) return 0xFFFFFFFF;                      // no asyncify driver ⇒ no fetch
        const url = dec.decode(new Uint8Array(mem.buffer, ptr, len));
        rangeAsked++;                                         // attempts, so a blocked read is visible
        ctrl.httpBytes = null; ctrl.httpTotal = -1;
        const last = off + n - 1;
        // The prefetch hit: answer SYNCHRONOUSLY, with no fetch and no asyncify unwind. Safe for exactly
        // the reason the sidecar hit is — nothing suspends, so there is no rewind to get wrong.
        const bag = prefetched.get(url.split('?')[0]);
        if (bag && bag.size) {
          const p0 = Math.floor(off / PFPAGE), p1 = Math.floor((off + n - 1) / PFPAGE);
          let all = true;
          for (let p = p0; p <= p1 && all; p++) if (!bag.has(p)) all = false;
          if (all) {
            let outb;
            if (p0 === p1) {
              const pg = bag.get(p0);
              const s0 = off - p0 * PFPAGE;
              outb = (s0 === 0 && pg.length === n) ? pg : pg.subarray(s0, s0 + n);
            } else {
              outb = new Uint8Array(n);
              for (let p = p0, w = 0; p <= p1; p++) {
                const pg = bag.get(p), pStart = p * PFPAGE;
                const from = Math.max(off, pStart) - pStart;
                const to = Math.min(off + n, pStart + pg.length) - pStart;
                outb.set(pg.subarray(from, to), w); w += to - from;
              }
            }
            // RETAINED, not drained — see PFCAP above. A page the ring asks for next is already here.
            prefetchHits++; prefetchBytes += outb.length;
            ctrl.httpBytes = outb;
            ctrl.httpTotal = prefetchTotals.get(url.split('?')[0]) ?? -1;
            rangeReads++; rangeBytes += outb.length;
            const shk = url.split('?')[0].split('/').pop() || url;
            const pse = perStore.get(shk) || { reads: 0, bytes: 0 };
            pse.reads++; pse.bytes += outb.length; perStore.set(shk, pse);
            return outb.length;
          }
          prefetchMiss++;
          // ⚠ WHY it missed, because the two causes need opposite fixes. A page we DID fetch and then
          // drained on consume is a RETENTION failure — the ring wants the ground the view just read, and
          // the dedup rightly refuses to buy it twice, so the read goes serial. A page never fetched at
          // all is an INDEX failure — the query did not name it. Counting them together says only "some
          // reads were not in the buffer", which is what the last live run left unexplained.
          // With retention, a miss is either a page never named for this viewport or one the cap
          // evicted. `evictedPages` is what tells them apart, and the split decides whether to widen the
          // query or to raise the cap — opposite fixes, as ever.
          const ev = evictedPages.get(url.split('?')[0]);
          let evicted = false;
          for (let p = p0; p <= p1; p++) if (ev && ev.has(p)) evicted = true;
          if (evicted) prefetchMissDrained++; else prefetchMissUnknown++;
        }
        // ⚠ THE PERSISTENT TIER, ON THE MISS PATH TOO — not only in `prefetch`. A view that was never
        // planned (offline, where the index cannot be fetched; or a camera the pack did not anticipate)
        // reaches the store through HERE, so wiring only the prefetch left a saved route unreadable with
        // the network off: every read fell straight through to a fetch that could not complete.
        const cacheSha = shaOf(url);
        const p0c = Math.floor(off / PFPAGE), p1c = Math.floor(last / PFPAGE);
        const wantPages = [];
        for (let p = p0c; p <= p1c; p++) wantPages.push(p);
        // ⚠ THE SIZE PROBE IS A READ LIKE ANY OTHER, and skipping it (`n > 1`) is why an offline map drew
        // NOTHING while 862 pages sat on the device. loft opens a paged store by asking for ONE byte and
        // reading the total out of `Content-Range`; with no network that request fails, the loader never
        // learns the file's length, and it gives up before touching a single page. The length is in
        // `coverage.json` — the app knows it without asking anyone — so it is answered locally.
        const knownTotal = sizeOf(url);
        if (knownTotal) ctrl.httpTotal = knownTotal;
        const fromStore = (persist && cacheSha)
          ? persist.getMany(cacheSha, wantPages).catch(() => new Map())
          : Promise.resolve(new Map());
        fromStore.then((held) => {
          if (held.size === wantPages.length) {
            // Every covering page is on this device: assemble and answer without touching the network.
            const outb = new Uint8Array(n);
            for (const p of wantPages) {
              const pg = held.get(p), pStart = p * PFPAGE;
              const from = Math.max(off, pStart) - pStart;
              const to = Math.min(off + n, pStart + pg.length) - pStart;
              if (to > from) outb.set(pg.subarray(from, to), Math.max(0, pStart + from - off));
            }
            rangeReads++; rangeBytes += outb.length;
            const shk2 = url.split('?')[0].split('/').pop() || url;
            const pse2 = perStore.get(shk2) || { reads: 0, bytes: 0 };
            pse2.reads++; pse2.bytes += outb.length; perStore.set(shk2, pse2);
            persistHits++;
            // Answered exactly as the fetch path answers: fill the slot, restore the total from what the
            // buffer already knows, and wake the suspended kernel. (`back` belongs to `http_get`'s scope,
            // not this one — calling it here threw a ReferenceError the first time.)
            ctrl.httpBytes = outb;
            ctrl.httpTotal = prefetchTotals.get(url.split('?')[0]) ?? ctrl.httpTotal ?? -1;
            wake('fetch');
            return;
          }
          fetchRange();
        });
        const fetchRange = () => fetch(url, { headers: { Range: `bytes=${off}-${last}` } })
          .then(async (res) => {
            // The total rides on Content-Range (`bytes a-b/TOTAL`), so size() needs no second round trip.
            const cr = res.headers.get('Content-Range');
            if (cr) { const t = cr.split('/').pop(); ctrl.httpTotal = (t && t !== '*') ? Number(t) : -1; }
            else { const cl = res.headers.get('Content-Length'); ctrl.httpTotal = cl ? Number(cl) : -1; }
            // 206 = the body IS the window. 200 = the server ignored Range and sent everything; slice it,
            // so a host without Range support is merely slow rather than wrong.
            if (!res.ok) { rangeFails.push({ url, off, n, status: res.status }); rangeFailed++; ctrl.httpBytes = null; }
            else {
              const b = new Uint8Array(await res.arrayBuffer());
              ctrl.httpBytes = (res.status === 206) ? b : b.subarray(off, off + n);
              // Counted on DELIVERY. The first version counted the request, so a cross-origin read that
              // the browser blocked still reported "38 range reads, 2.3 MB" while the matcher got nothing.
              rangeReads++; rangeBytes += ctrl.httpBytes.length;
              // WRITE-BEHIND on the miss path too: ground the user actually visited online is then
              // readable on the trip, without anyone having pressed save.
              if (persist && cacheSha && res.status === 206 && off % PFPAGE === 0 && ctrl.httpBytes.length >= PFPAGE) {
                const m = new Map();
                for (let q = 0; (q + 1) * PFPAGE <= ctrl.httpBytes.length; q++) {
                  m.set(off / PFPAGE + q, new Uint8Array(ctrl.httpBytes.subarray(q * PFPAGE, (q + 1) * PFPAGE)));
                }
                if (m.size) persist.putMany(cacheSha, m).catch(() => {});
              }
              const sk = url.split('?')[0].split('/').pop() || url;
              const pe = perStore.get(sk) || { reads: 0, bytes: 0 };
              pe.reads++; pe.bytes += ctrl.httpBytes.length; perStore.set(sk, pe);
            }
            wake('fetch');
          })
          .catch((e) => {
            // A cross-origin read that the browser refuses lands HERE, not at the server — which is why a
            // server log shows nothing and the app just renders an empty corridor. Record it so a gate can
            // say which read failed and why instead of only that the count came up short.
            rangeFails.push({ url, off, n, err: String(e && e.message || e) }); rangeFailed++;
            ctrl.httpBytes = null; wake('fetch');
          });
        waiting = 'fetch'; ctrl.ac.suspend();
        return 0;
      },
      loft_host_http_range_total: () => (ctrl.httpTotal != null ? ctrl.httpTotal : -1),
      // @PLN105 expose(tag, value) — the LONG-LIVED handle to a loft value in wasm memory. loft has
      // pinned the store read-only, so `storeBase`/`rec`/`pos` stay valid across frames and JS can read
      // the records directly (addr(rec,pos) = storeBase + rec*8 + pos) instead of parsing text. `desc` is
      // the layout descriptor (LayoutDesc::to_json) that says how. `tag` arrives as a BigInt (i64).
      //
      // NOTE the descriptor is read HERE, inside the call: the borrow is only guaranteed for its
      // duration, and mem.buffer detaches on memory.grow — so the JSON is copied out now, and every
      // later read must re-derive its view from the CURRENT mem.buffer.
      loft_host_expose: (tag, storeBase, rec, pos, typeId, descPtr, descLen) => {
        globalThis.__exposeCalls = (globalThis.__exposeCalls || 0) + 1;
        globalThis.__exposeArgs = { tag: String(tag), storeBase: String(storeBase), rec: String(rec), pos: String(pos), typeId: String(typeId), descLen: String(descLen) };
        let desc = null;
        try { desc = JSON.parse(dec.decode(new Uint8Array(mem.buffer, descPtr, descLen))); } catch (e) { desc = { __parseError: String(e) }; }
        exposed.set(Number(tag), { storeBase, rec, pos, typeId, desc, descLen });
      },
      // @PLN105 release(tag, value) — loft is unpinning the store, so every address handed out under
      // `tag` is dead from here until the next expose. Drop the handle rather than leave a stale one
      // readable: the kernel releases precisely because it is about to WRITE the store (a reload) or
      // ITERATE it (the view walk claims a cursor record inside it), so anything JS read now would be
      // racing loft's own mutation. `tag` arrives as a BigInt (i64), matching loft_host_expose.
      loft_host_release: (tag) => {
        globalThis.__releaseCalls = (globalThis.__releaseCalls || 0) + 1;
        exposed.delete(Number(tag));
      },
    },
    // frame_yield() — loft hands the frame back, both while idle-polling for a command and between
    // match stretches (PLAN-PERF §6b A).
    //
    // The resume must be a MACROTASK, not a rAF callback. rAF runs BEFORE paint, so resuming there
    // executes the next chunk of loft work inside the frame callback and blocks the very paint it was
    // meant to yield to — measured: 1 frame of ~497 landed, the whole match one frozen gap, even with
    // 39 yield points. setTimeout(0) runs AFTER the paint, so the browser actually draws between chunks.
    loft_web: {
      ws_yield: () => {
        if (!ctrl.ac) return;
        if (ctrl.ac.exports.asyncify_get_state() === 2) { ctrl.ac.suspend(); return; }   // rewinding → carry on
        waiting = 'yield';
        // Deliver in a MICROTASK, wake in a macrotask — the order is the whole point. The microtask runs
        // once this unwind has returned to the event loop but BEFORE the browser paints, so whatever the
        // sink draws is on screen in the very frame the yield handed back. Draining inside this import
        // instead would run the sink mid-unwind; draining in the setTimeout would put it after the paint,
        // and the stretch would appear one frame late (or not at all, if loft resumes and blocks).
        if (onLine) queueMicrotask(drain);
        setTimeout(() => wake('yield'), 0);
        ctrl.ac.suspend();
      },
    },
  };
  const bytes = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  const r = await WebAssembly.instantiate(bytes, imports);
  mem = r.instance.exports.memory;
  if (r.instance.exports.asyncify_start_unwind) ctrl.ac = new AsyncifyCtrl(r.instance);

  // Push a command and wait for its `#EOR`. Callers serialize (await one before the next); the kernel
  // reads exactly one blob per pass, so a queued command is picked up by the next poll.
  //
  // `lineSink` is optional: pass it to receive each output line AS LOFT FLUSHES IT (see `drain`) instead
  // of only the whole text at the end. The promise still resolves with the complete response either way,
  // so a sink is a strictly additional view of the same bytes — it cannot change what the caller parses.
  // ⚠ ONE RESOLVE SLOT, SO CALLS MUST NOT OVERLAP — and this is where that is made true, rather than
  // hoped for. `resolveRun` below is a single variable: a second call entering while the first is in
  // flight overwrites it and ORPHANS the first promise, which is PLAN-EDIT's P4 in its rawest form (a
  // command that never resolves, and an awaiting caller that never wakes).
  //
  // `KernelQueue` has always guarded the APP's road, and while the app was the only caller that was
  // enough. It stopped being enough when the app grew work that OUTLIVES the view that scheduled it (the
  // ring prefetch): the ~20 probe calls in store-app's `__perfHooks` block deliberately bypass the queue
  // to measure the kernel in isolation, and a ring cell landing between a probe's `reset` and its `match`
  // was returning an empty route — measured, as `cors_host_gate` failing with `ways=0`.
  //
  // So serialise at the ROOT instead of at each of the twenty call sites. The queue keeps its own job,
  // which is different and still needed: it COALESCES by key, so a drag emitting 33 moves a second owes
  // one match rather than thirty-three. This only makes overlap safe instead of corrupting.
  let tail = Promise.resolve();
  function runKernel(blob, lineSink) {
    const p = tail.then(() => runKernelNow(blob, lineSink), () => runKernelNow(blob, lineSink));
    tail = p.catch(() => {});          // a failed command must not wedge every command after it
    return p;
  }
  function runKernelNow(blob, lineSink) {
    return new Promise((resolve) => {
      resolveRun = resolve;
      onLine = lineSink || null;
      scanned = 0;
      commands++;
      inQ.push(enc.encode(String(blob)));
      if (!ctrl.ac) { r.instance.exports.loft_start(); resolveRun = null; onLine = null; resolve(outBuf); outBuf = ''; return; }
      if (!started) { started = true; starts++; ctrl.ac.start('loft_start'); pump(); }   // never returns; suspends on the first idle poll
      else wake('yield');                                                                // idle → hand it the command now, don't wait a frame
    });
  }
  // `storeLoads` counts actual store fetches. It is the variance-immune proof of the session: no matter
  // how many commands run, a session loads each store ONCE (2 total: layout + roads). Timing cannot show
  // this — the run-to-run spread is larger than the load itself (PLAN-PERF §5 C0) — but a count can.
  //
  // `starts` is the load-bearing invariant of this driver, so it is observable rather than argued:
  // loft_start must be entered EXACTLY ONCE for a session, no matter how many commands run through it.
  // If it ever exceeds 1, loft is no longer owning the loop and the store/Graph/MatchState a session
  // holds (steps 6-8) would be silently rebuilt. tools/map_profile.sh asserts it.
  // wasm linear memory, in bytes. The session holds state now, so a per-command climb here is a LEAK,
  // not noise — and it would explain cost growing with session history (PLAN-PERF §5 C0).
  //
  // `deliveries` counts the YIELD POINTS at which a line sink actually received output — i.e. how many
  // separate batches a response arrived in. It is the count-based proof that streaming is real: a
  // response that lands all at once delivers ONCE no matter how many STRETCH lines it contains, so
  // `deliveries >= stretches` can only hold if each stretch genuinely reached JS mid-match. Timing cannot
  // show this reliably (a loaded box moves every millisecond); a count can.
  return {
    runKernel,
    stats: () => ({ starts, commands, storeLoads, sidecarLoads, sidecarHits, rangeReads, rangeBytes, rangeAsked, rangeFails: rangeFails.slice(0, 4), rangeFailed, deliveries, wasmBytes: mem.buffer.byteLength, exposed: exposed.size, perStore: Object.fromEntries(perStore), wholeLoads: Object.fromEntries(wholeLoads), prefetchHits, prefetchMiss, prefetchMissDrained, prefetchMissUnknown, prefetchBytes, prefetchDownloadBytes, prefetchPeakBytes, prefetchEvicted, prefetchMaxBatchBytes, prefetchCap: PFCAP, persistHits, prefetchHeld: [...prefetched.values()].reduce((a, m) => a + m.size, 0) }),
    // Fill the prefetch buffer for `url` with `ranges` ([[off, len], …]) — ALL AT ONCE. Resolves when the
    // batch has landed. The whole design rests on this being concurrent: issuing them one at a time would
    // reproduce exactly the serial depth it exists to remove.
    // `pages` is a list of PAGE NUMBERS. Adjacent ones are coalesced into a single range: it is what makes
    // the request count fall (measured 1.8x on base, 3.0x on roads), and on a per-request billed host
    // that is the difference between the same bill and half of it.
    // The app hands these in rather than importing them here: the kernel must stay usable by a driver
    // that has neither (every gate builds one), and `store-kernel` has no business knowing coverage.json.
    usePageCache: (mod, shas, sizes) => {
      persist = mod;
      shaOf = (u) => shas.get(u.split('?')[0]) || null;
      sizeOf = (u) => (sizes && sizes.get(u.split('?')[0])) || 0;
    },
    prefetch: async (url, pages, concurrency = 24) => {
      const key = url.split('?')[0];
      if (!prefetched.has(key)) prefetched.set(key, new Map());
      const bag = prefetched.get(key);
      // ⚠ TWO SEPARATE QUESTIONS, AND CONFLATING THEM COST A LIVE REGRESSION. "Do we hold this page" is
      // the bag; "have we already PAID for it" is `fetchedOnce`, and eviction makes the bag forget while
      // the wire does not. Dropping the second record on the reasoning that retention made it redundant
      // sent Amsterdam into a thrash — 5 520 pages / 361.8 MB fetched for a session whose DISTINCT pages
      // are 2 627 / 172.2 MB, because every eviction made a page buyable again. A page is bought at most
      // ONCE per session now; if the cap evicted it, the read falls through to a normal fetch, which is
      // one round trip instead of a second purchase.
      if (!fetchedOnce.has(key)) fetchedOnce.set(key, new Set());
      const seen = fetchedOnce.get(key);
      let sorted = [...new Set(pages)].filter((p) => !bag.has(p) && !seen.has(p)).sort((a, b) => a - b);
      // ⚠ READ THE PERSISTENT TIER FIRST, and take it out of the fetch list — a page that is already on
      // this device must never be bought again. This is the whole win for a second visit, and it is the
      // same mechanism that makes a saved route readable with no network at all.
      const sha = shaOf(url);
      let fromDisk = 0;
      if (persist && sha && sorted.length) {
        try {
          const held = await persist.getMany(sha, sorted);
          for (const [p, b] of held) { bag.set(p, b); prefetchHeldBytes += b.length; seen.add(p); }
          if (held.size) {
            fromDisk = held.size;
            sorted = sorted.filter((p) => !held.has(p));
            if (prefetchHeldBytes > prefetchPeakBytes) prefetchPeakBytes = prefetchHeldBytes;
            evict();
          }
        } catch { /* a cache that will not read is not a reason to fail a view */ }
      }
      for (const p of sorted) seen.add(p);
      inFlight = { key, pages: new Set(sorted) };
      let batchBytes = 0;
      const fetchedNow = new Map();      // page -> bytes, for the write-behind below
      const runs = [];
      for (const p of sorted) {
        const last = runs[runs.length - 1];
        if (last && p === last[1] + 1) last[1] = p; else runs.push([p, p]);
      }
      const ranges = runs.map(([a, b]) => [a * PFPAGE, (b - a + 1) * PFPAGE]);
      let i = 0, ok = 0, failed = 0;
      const worker = async () => {
        while (i < ranges.length) {
          const j = i++;
          const [off, n] = ranges[j];
          try {
            const res = await fetch(url, { headers: { Range: `bytes=${off}-${off + n - 1}` } });
            if (!res.ok) { failed++; continue; }
            const cr = res.headers.get('Content-Range');
            if (cr) { const t = cr.split('/').pop(); if (t && t !== '*') prefetchTotals.set(url, Number(t)); }
            const b0 = new Uint8Array(await res.arrayBuffer());
            const b = res.status === 206 ? b0 : b0.subarray(off, off + n);
            prefetchDownloadBytes += b.length;
            for (let q = 0; q * PFPAGE < b.length; q++) {
              // ⚠ COPIED, NOT A SUBARRAY. A `subarray` shares its parent ArrayBuffer, so a retained page
              // pins the WHOLE coalesced fetch it came from — up to 24 pages — and evicting one page of
              // that run frees nothing at all. The cap would then bound a number that is not the memory:
              // `prefetchHeldBytes` counts page lengths while the heap holds parents. One 64 kB copy per
              // page is cheap beside the round trip that fetched it, and it makes eviction actually free.
              const pg = new Uint8Array(b.subarray(q * PFPAGE, Math.min((q + 1) * PFPAGE, b.length)));
              bag.set(off / PFPAGE + q, pg);
              fetchedNow.set(off / PFPAGE + q, pg);
              prefetchHeldBytes += pg.length;
              batchBytes += pg.length;
            }
            if (prefetchHeldBytes > prefetchPeakBytes) prefetchPeakBytes = prefetchHeldBytes;
            evict();
            ok++;
          } catch {
            failed++;
            // Nothing arrived, so nothing was paid for: let a later batch try these pages again.
            for (let q = 0; q * PFPAGE < n; q++) fetchedOnce.get(key)?.delete(off / PFPAGE + q);
          }
        }
      };
      const t0 = performance.now();
      await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, worker));
      inFlight = null;
      // WRITE-BEHIND, never awaited: what a page costs to keep must not be added to what a view costs to
      // draw. A failed write is a slower next visit and nothing else.
      if (persist && sha && fetchedNow.size) {
        persist.putMany(sha, fetchedNow, prefetchPackId).catch(() => {});
      }
      // The peak can exceed the cap only by one in-flight batch (see `evict`), so recording the largest
      // batch gives that excess an exact bound instead of a guessed constant in a gate.
      if (batchBytes > prefetchMaxBatchBytes) prefetchMaxBatchBytes = batchBytes;
      evict();                    // the batch is complete and readable; NOW the cap applies to it too
      return { pages: sorted.length, requests: ranges.length, ok, failed, fromDisk,
               ms: Math.round(performance.now() - t0), held: bag.size };
    },
    // While this is set, every page the prefetch fetches is pinned to that pack (see page-cache.mjs).
    packInto: (id) => { prefetchPackId = id; },
    // The exposed handle for `tag`, or null. `mem` comes with it because every read must re-derive its
    // view from the CURRENT buffer — memory.grow detaches the old one.
    exposedValue: (tag) => exposed.get(tag) || null,
    memory: () => mem,
  };
}
