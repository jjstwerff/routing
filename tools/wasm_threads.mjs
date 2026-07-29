// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-PERF §0 step 18's tripwire: is the app's browser kernel built WITH THREADS?
//
// `par` is the whole of step 18, and in the browser it is a no-op while the kernel wasm has no thread
// support: loft's WASM (single) profile compiles `threading` OFF, so `par()` falls back to Tier 1
// (sequential). That is not a guess — this reads the shipped artifact.
//
// ⚠ THE FIRST VERSION OF THIS FILE WAS BLIND (fixed 2026-07-29, PLAN-PERF §6e). It looked for a SHARED
// flag in the memory SECTION only. A threaded wasm does not define a memory at all — it IMPORTS a shared
// one (`env.memory`, shared=true, max=16384), so the memory section is empty and the old check reported
// `memories=0 shared=?` and then printed "✓ single-threaded" for a genuinely threaded bundle. The alarm
// that HANDOFF called "fails the day the kernel wasm gains threads" would have stayed green on that day.
// Measured on a real `loft --html` threaded bundle, not reasoned about.
//
// So the artifact is now read three ways, any one of which means THREADED:
//   * a SHARED memory, whether IMPORTED (the threaded shape) or DEFINED in the memory section;
//   * lld's TLS bootstrap exports (`__wasm_init_tls` / `__tls_size` / `__tls_align` / `__tls_base`),
//     which only survive in a `+atomics` link — parsed out of the export section, not byte-searched;
//   * (informational) whether Rust's no-threads std shims were linked in (`no_threads.rs` in the panic
//     paths). A threaded build drops them, but their absence alone is not proof, so it does not vote.
//
// And because a detector that never sees a positive case is a comment, `--self-test` (which runs on EVERY
// invocation) feeds it three hand-assembled modules — imported-shared, plain-defined, and TLS-exports-only
// — so both signals are proven to fire and not to false-fire before the real verdict is printed.
//
// To regenerate a REAL threaded bundle to check against (needs nightly + rust-src):
//   printf 'fn heavy(x: integer) -> integer { x * 2 }\nfn main() {\n    data = [1, 2, 3];\n    sum = 0;\n    for a in data par(b = heavy(a), 8) { sum += b; }\n    println("{sum}");\n}\n' > par.loft
//   loft --html par.html par.loft            # threaded: loft picks it from the reachable `par`
//   loft --html plain.html --no-threads par.loft
//   node -e 'const h=require("fs").readFileSync("par.html","utf8");require("fs").writeFileSync("par.wasm",Buffer.from(h.match(/AGFzbQ[A-Za-z0-9+\/=]+/)[0],"base64"))'
//   node tools/wasm_threads.mjs par.wasm     # must FAIL (it is threaded) — that is the detector working
//
// It asserts the state PLAN-PERF records, so if the app's kernel ever gains threads this fails and the
// plan gets corrected instead of quietly staying wrong. ⚠ But it is NOT the cue for step 18 and never
// was: the kernel only gains threads once WE add a reachable `par` to it, so this gate cannot announce a
// toolchain change. loft's browser `par` HAS landed (@PLN117, proven on the installed 2026.7.2); what
// gates step 18 now is COOP/COEP on the deploy host. See PLAN-PERF §6e.
//
//   node tools/wasm_threads.mjs [path/to/kernel.wasm]
import { readFileSync } from 'node:fs';

// LEB128 unsigned.
const u32 = (b, i) => { let r = 0, s = 0, x; do { x = b[i++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return [r >>> 0, i]; };
const name = (b, i) => { let n; [n, i] = u32(b, i); return [b.toString('utf8', i, i + n), i + n]; };

const TLS_SYMS = ['__wasm_init_tls', '__tls_size', '__tls_align', '__tls_base'];

// Read the three thread signals out of a wasm module.  Sections walked: 2 (import), 5 (memory), 7 (export).
function inspect(d) {
  const r = { defined: 0, importedMem: null, shared: null, max: null, tls: [], noThreadsStd: d.includes('no_threads.rs') };
  let i = 8;
  while (i < d.length) {
    const id = d[i++];
    let size; [size, i] = u32(d, i);
    const end = i + size;
    if (id === 2) {                                  // import section — where a THREADED wasm's memory lives
      let j = i, n; [n, j] = u32(d, j);
      for (let k = 0; k < n && j < end; k++) {
        let mod, nm; [mod, j] = name(d, j); [nm, j] = name(d, j);
        const kind = d[j++];
        if (kind === 0) { let t; [t, j] = u32(d, j); }                                   // func: typeidx
        else if (kind === 1) { j++; let fl, mn; [fl, j] = u32(d, j); [mn, j] = u32(d, j); if (fl & 1) { let mx; [mx, j] = u32(d, j); } }
        else if (kind === 2) {                                                            // memory
          let fl, mn; [fl, j] = u32(d, j); [mn, j] = u32(d, j);
          if (fl & 1) { let mx; [mx, j] = u32(d, j); r.max = mx; }
          r.importedMem = `${mod}.${nm}`;
          if (fl & 2) r.shared = true; else if (r.shared === null) r.shared = false;      // bit 1 = shared
        }
        else if (kind === 3) { j += 2; }                                                  // global: valtype + mut
        else break;                        // unknown import kind (tag/…): stop rather than misparse the rest
      }
    } else if (id === 5) {                            // memory section — the SINGLE-threaded shape
      let j = i, n; [n, j] = u32(d, j);
      for (let k = 0; k < n && j < end; k++) {
        let fl, mn; [fl, j] = u32(d, j); [mn, j] = u32(d, j);
        if (fl & 1) { let mx; [mx, j] = u32(d, j); r.max = mx; }
        r.defined++;
        if (fl & 2) r.shared = true; else if (r.shared === null) r.shared = false;
      }
    } else if (id === 7) {                            // export section — lld's TLS bootstrap
      let j = i, n; [n, j] = u32(d, j);
      for (let k = 0; k < n && j < end; k++) {
        let nm; [nm, j] = name(d, j); j++; let idx; [idx, j] = u32(d, j);
        if (TLS_SYMS.includes(nm)) r.tls.push(nm);
      }
    }
    i = end;
  }
  return r;
}

const threadedBy = r => [r.shared === true ? 'shared memory' : null, r.tls.length ? `TLS exports (${r.tls.join(', ')})` : null].filter(Boolean);

const describe = r => `memory=${r.importedMem ? `IMPORTED(${r.importedMem})` : r.defined ? 'DEFINED' : 'none'}`
  + ` shared=${r.shared === null ? '?' : r.shared}${r.max === null ? '' : ` max=${r.max}`}`
  + ` tlsExports=${r.tls.length ? r.tls.length : 'none'} noThreadsStd=${r.noThreadsStd}`;

// --- positive + negative controls, on every run -------------------------------------------------------
// Hand-assembled section bytes (header + the one section each case is about).  A detector that has never
// been shown a threaded module is a comment: the real bundles that produced these shapes are 550 KB, so
// the shapes themselves are committed instead.
const HEAD = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const CONTROLS = [
  // 1. what a real `loft --html` threaded bundle looks like: import "env"."memory", flags=has-max|shared, min=17, max=16384
  ['imported shared memory', true, Buffer.from([...HEAD,
    0x02, 0x12, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79,
    0x02, 0x03, 0x11, 0x80, 0x80, 0x01])],
  // 2. what `--no-threads` (and today's kernel) looks like: one DEFINED memory, flags=0, min=17
  ['defined plain memory', false, Buffer.from([...HEAD, 0x05, 0x03, 0x01, 0x00, 0x11])],
  // 3. the second signal alone: a plain memory, but the TLS bootstrap is exported
  ['TLS exports only', true, Buffer.from([...HEAD, 0x05, 0x03, 0x01, 0x00, 0x11,
    0x07, 0x13, 0x01, 0x0f, ...Buffer.from('__wasm_init_tls'), 0x00, 0x00])],
];
let ctlFail = 0;
for (const [label, want, bytes] of CONTROLS) {
  let got;
  try { got = threadedBy(inspect(bytes)).length > 0; } catch (e) { got = `threw ${e.message}`; }
  if (got !== want) { console.log(`  FAIL self-test: "${label}" → threaded=${got}, expected ${want} — the DETECTOR is broken, not the kernel.`); ctlFail = 1; }
}
if (ctlFail) process.exit(1);
console.log(`  self-test: ${CONTROLS.length}/${CONTROLS.length} controls detected correctly (imported-shared, defined-plain, TLS-only)`);

// --- the real artifact --------------------------------------------------------------------------------
const path = process.argv[2] || new URL('../browser/store-kernel.wasm', import.meta.url).pathname;
let d;
try { d = readFileSync(path); } catch { console.log(`SKIP: ${path} missing (build: node browser/build-store-kernel.mjs)`); process.exit(2); }
if (d.readUInt32LE(0) !== 0x6d736100) { console.log('FAIL: not a wasm module'); process.exit(1); }

const r = inspect(d);
const why = threadedBy(r);
console.log(`  kernel wasm: ${describe(r)}`);
if (why.length) {
  console.log(`  FAIL: the browser kernel is now THREADED — ${why.join(' + ')} — and PLAN-PERF §6e says it is not.`);
  console.log('        `par` is no longer a no-op in the browser: REVISIT step 18 and update the plan.');
  console.log('        ⚠ Check the DEPLOY side too — Tier 2 needs COOP/COEP, which GitHub Pages cannot send (§6e).');
  process.exit(1);
}
console.log('  ✓ browser kernel is single-threaded — `par` runs sequentially there (PLAN-PERF §6e, step 18)');
process.exit(0);
