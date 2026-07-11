// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// Host driver for the loft --html base-map kernel (client/web_basemap_kernel.loft, extracted to
// store-kernel.wasm): lets a JS renderer drive it as `runKernel(blob) -> Promise<text>`. Reuses the
// loft --html shell's AsyncifyCtrl + loft_io imports verbatim — store_load_url_trusted's fetch is bridged
// to JS fetch() via asyncify, and loft_start rebuilds fresh Stores each call, so every runKernel() is an
// independent view/match request. (The browser HTTP-caches the store, so the refetch is a decode.)

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

// Instantiate the kernel wasm once and return { runKernel }. Calls are serialized by the caller (await one
// before the next) — loft_start is not re-entrant mid-fetch.
export async function createKernel(wasmUrl) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const inQ = [];
  const ctrl = { ac: null, httpBytes: null };
  let mem, outBuf = '', resolveRun = null;
  const finishIfDone = () => { if (ctrl.ac && !ctrl.ac.sleeping && resolveRun) { const r = resolveRun; resolveRun = null; r(outBuf); } };
  const imports = { loft_io: {
    loft_host_print: (ptr, len) => { outBuf += dec.decode(new Uint8Array(mem.buffer, ptr, len)); },
    loft_host_input_len: () => (inQ.length ? inQ[0].length : 0),
    loft_host_input_copy: (ptr) => { const b = inQ.shift(); if (b) new Uint8Array(mem.buffer, ptr, b.length).set(b); },
    loft_host_output: (/* ptr, len */) => {},                 // structured out — unused by this kernel
    loft_host_http_get: (ptr, len) => {
      if (ctrl.ac && ctrl.ac.exports.asyncify_get_state() === 2) { ctrl.ac.suspend(); return ctrl.httpBytes ? ctrl.httpBytes.length : 0xFFFFFFFF; }
      const url = dec.decode(new Uint8Array(mem.buffer, ptr, len));
      ctrl.httpBytes = null;
      fetch(url).then(async (r) => { ctrl.httpBytes = r.ok ? new Uint8Array(await r.arrayBuffer()) : null; ctrl.ac.resume('loft_start'); finishIfDone(); })
                .catch(() => { ctrl.httpBytes = null; ctrl.ac.resume('loft_start'); finishIfDone(); });
      if (ctrl.ac) ctrl.ac.suspend();
      return 0;
    },
    loft_host_http_get_copy: (ptr) => { if (ctrl.httpBytes) new Uint8Array(mem.buffer, ptr, ctrl.httpBytes.length).set(ctrl.httpBytes); },
  } };
  const bytes = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  const r = await WebAssembly.instantiate(bytes, imports);
  mem = r.instance.exports.memory;
  if (r.instance.exports.asyncify_start_unwind) ctrl.ac = new AsyncifyCtrl(r.instance);

  function runKernel(blob) {
    return new Promise((resolve) => {
      outBuf = ''; inQ.length = 0; inQ.push(enc.encode(String(blob)));
      resolveRun = resolve;
      if (ctrl.ac) { ctrl.ac.start('loft_start'); finishIfDone(); }   // finishes here if it completed with no fetch
      else { r.instance.exports.loft_start(); resolveRun = null; resolve(outBuf); }
    });
  }
  return { runKernel };
}
