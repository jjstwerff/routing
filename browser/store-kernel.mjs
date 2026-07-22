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
  const ctrl = { ac: null, httpBytes: null };
  const exposed = new Map();   // tag -> { storeBase, rec, pos, typeId, desc } from expose() (step 9)
  let mem, outBuf = '', resolveRun = null, started = false, starts = 0, commands = 0, storeLoads = 0;
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
        storeLoads++;              // counted on the UNWIND pass only — the rewind above returns early
        ctrl.httpBytes = null;
        const back = (b) => { ctrl.httpBytes = b; wake('fetch'); };
        fetch(url).then(async (res) => back(res.ok ? new Uint8Array(await res.arrayBuffer()) : null))
                  .catch(() => back(null));
        if (ctrl.ac) { waiting = 'fetch'; ctrl.ac.suspend(); }
        return 0;
      },
      loft_host_http_get_copy: (ptr) => { if (ctrl.httpBytes) new Uint8Array(mem.buffer, ptr, ctrl.httpBytes.length).set(ctrl.httpBytes); },
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
  function runKernel(blob, lineSink) {
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
    stats: () => ({ starts, commands, storeLoads, deliveries, wasmBytes: mem.buffer.byteLength, exposed: exposed.size }),
    // The exposed handle for `tag`, or null. `mem` comes with it because every read must re-derive its
    // view from the CURRENT buffer — memory.grow detaches the old one.
    exposedValue: (tag) => exposed.get(tag) || null,
    memory: () => mem,
  };
}
