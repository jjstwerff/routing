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
  let mem, outBuf = '', resolveRun = null, started = false, starts = 0, commands = 0;
  let waiting = null;   // why loft is suspended: 'fetch' | 'yield' | null — see the header note

  // Resolve the in-flight command once its terminator lands. Checked whenever loft suspends (it prints
  // the whole response, then loops and yields), never per print — that would scan 29k lines a view.
  const pump = () => {
    if (!resolveRun) return;
    const i = outBuf.indexOf(EOR);
    if (i < 0) return;
    const out = outBuf.slice(0, i);
    outBuf = outBuf.slice(i + EOR.length).replace(/^\n/, '');
    const done = resolveRun; resolveRun = null; done(out);
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
        ctrl.httpBytes = null;
        const back = (b) => { ctrl.httpBytes = b; wake('fetch'); };
        fetch(url).then(async (res) => back(res.ok ? new Uint8Array(await res.arrayBuffer()) : null))
                  .catch(() => back(null));
        if (ctrl.ac) { waiting = 'fetch'; ctrl.ac.suspend(); }
        return 0;
      },
      loft_host_http_get_copy: (ptr) => { if (ctrl.httpBytes) new Uint8Array(mem.buffer, ptr, ctrl.httpBytes.length).set(ctrl.httpBytes); },
    },
    // frame_yield() — loft hands the frame back while it waits for the next command. Resuming on rAF is
    // what keeps the page painting during a long idle poll AND bounds the poll to ~1/frame rather than
    // a hard spin.
    loft_web: {
      ws_yield: () => {
        if (!ctrl.ac) return;
        if (ctrl.ac.exports.asyncify_get_state() === 2) { ctrl.ac.suspend(); return; }   // rewinding → carry on
        waiting = 'yield';
        requestAnimationFrame(() => wake('yield'));
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
  function runKernel(blob) {
    return new Promise((resolve) => {
      resolveRun = resolve;
      commands++;
      inQ.push(enc.encode(String(blob)));
      if (!ctrl.ac) { r.instance.exports.loft_start(); resolveRun = null; resolve(outBuf); outBuf = ''; return; }
      if (!started) { started = true; starts++; ctrl.ac.start('loft_start'); pump(); }   // never returns; suspends on the first idle poll
      else wake('yield');                                                                // idle → hand it the command now, don't wait a frame
    });
  }
  // `starts` is the load-bearing invariant of this driver, so it is observable rather than argued:
  // loft_start must be entered EXACTLY ONCE for a session, no matter how many commands run through it.
  // If it ever exceeds 1, loft is no longer owning the loop and the store/Graph/MatchState a session
  // holds (steps 6-8) would be silently rebuilt. tools/map_profile.sh asserts it.
  return { runKernel, stats: () => ({ starts, commands }) };
}
