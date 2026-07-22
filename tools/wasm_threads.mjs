// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-PERF §0 step 18's tripwire: is the app's browser kernel built WITH THREADS?
//
// `par` is the whole of step 18, and in the browser it is a no-op: loft's WASM (single) profile compiles
// with `threading` OFF, so `par()` falls back to Tier 1 (sequential). That is not a guess — this checks
// the shipped artifact two ways:
//   * the memory section's `shared` flag (a threaded wasm imports/exports a SHARED memory), and
//   * whether Rust's no-threads std shims were linked in (`no_threads.rs` appears in the panic paths).
//
// It asserts the state PLAN-PERF records, so the day the toolchain gains browser threads this fails and
// the plan gets corrected instead of quietly staying wrong. Step 18 is worth revisiting exactly then.
//
//   node tools/wasm_threads.mjs [path/to/kernel.wasm]
import { readFileSync } from 'node:fs';

const path = process.argv[2] || new URL('../browser/store-kernel.wasm', import.meta.url).pathname;
let d;
try { d = readFileSync(path); } catch { console.log(`SKIP: ${path} missing (build: node browser/build-store-kernel.mjs)`); process.exit(2); }
if (d.readUInt32LE(0) !== 0x6d736100) { console.log('FAIL: not a wasm module'); process.exit(1); }

// LEB128 unsigned.
const u32 = (b, i) => { let r = 0, s = 0, x; do { x = b[i++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return [r >>> 0, i]; };

let i = 8, shared = null, memCount = 0;
while (i < d.length) {
  const id = d[i++];
  let size; [size, i] = u32(d, i);
  const end = i + size;
  if (id === 5) {                       // memory section: count, then (flags, limits) per memory
    let j = i, flags;
    [memCount, j] = u32(d, j);
    [flags, j] = u32(d, j);
    shared = (flags & 2) !== 0;         // bit 1 = shared (threads proposal)
  }
  i = end;
}
const noThreadsStd = d.includes('no_threads.rs');
const threaded = shared === true;

console.log(`  kernel wasm: memories=${memCount} shared=${shared === null ? '?' : shared} noThreadsStd=${noThreadsStd}`);
if (threaded) {
  console.log('  FAIL: the browser kernel is now THREADED — PLAN-PERF §6e says it is not.');
  console.log('        `par` is no longer a no-op in the browser: REVISIT step 18 and update the plan.');
  process.exit(1);
}
console.log('  ✓ browser kernel is single-threaded — `par` runs sequentially there (PLAN-PERF §6e, step 18)');
process.exit(0);
