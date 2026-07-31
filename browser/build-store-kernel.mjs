// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// Regenerate browser/store-kernel.wasm — the loft-wasm base-map kernel the standalone app drives.
// Compiles client/web_basemap_kernel.loft with `loft --html` and extracts the embedded wasm (store-app.mjs
// loads it as a callable module via store-kernel.mjs). The .wasm is COMMITTED and built by hand; run this
// whenever a kernel source or the loft toolchain changes.
//
//   node browser/build-store-kernel.mjs                      # build (needs loft on PATH, or $LOFT_BIN)
//   node browser/build-store-kernel.mjs --print-source-hash  # just the hash, no build (the gate's caller)
//
// It also writes `store-kernel.wasm.sources`: a sha256 over the kernel sources it built from.
// tools/map_render_gate.sh compares that against a fresh hash to detect a wasm built from older sources.
//
// ⚠ THAT SIDECAR REPLACED AN MTIME COMPARISON, and the reason generalises: **git does not preserve
// mtimes.** The check used to be `find <kernel srcs> -newer store-kernel.wasm`, which reads whatever
// order the last checkout happened to write files in. Measured 2026-07-31, right after a merge: the
// wasm was written at 08:03:23.568 and routing_kernel.loft at 08:03:23.588 — 20 ms later, same
// checkout, nothing edited — and a correct wasm was reported STALE. The dangerous direction is the
// other one: a genuinely stale wasm written last passes, and the gate exists precisely to catch that.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const loft = process.env.LOFT_BIN || 'loft';

// The same three trees the gate used to scan, so the hash covers exactly what a stale wasm could miss.
const KERNEL_SRC_DIRS = ['lib/routing_kernel/src', 'lib/map_kernel/src', 'client'];

function kernelSources(dir, out = []) {
  for (const e of readdirSync(join(repo, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) kernelSources(rel, out);
    else if (e.name.endsWith('.loft')) out.push(rel);
  }
  return out;
}

// Sorted, and each entry mixes in its PATH as well as its bytes — so a rename, an added file or a
// deleted one all move the hash, not just an edit in place.
function sourceHash() {
  const h = createHash('sha256');
  for (const rel of KERNEL_SRC_DIRS.flatMap((d) => kernelSources(d)).sort()) {
    h.update(rel); h.update('\0');
    h.update(readFileSync(join(repo, rel))); h.update('\0');
  }
  return h.digest('hex');
}

if (process.argv.includes('--print-source-hash')) {
  console.log(sourceHash());
  process.exit(0);
}
const tmp = mkdtempSync(join(tmpdir(), 'store-kernel-'));
try {
  const html = join(tmp, 'k.html');
  execFileSync(loft, ['--html', html, '--lib', join(repo, 'lib'), join(repo, 'client/web_basemap_kernel.loft')], { stdio: 'inherit' });
  const m = readFileSync(html, 'utf8').match(/wasmB64="([A-Za-z0-9+/=]+)"/);
  if (!m) { console.error('no wasmB64 in the generated page'); process.exit(1); }
  const wasm = Buffer.from(m[1], 'base64');
  writeFileSync(join(here, 'store-kernel.wasm'), wasm);
  // Stamp the sources LAST, and only once the wasm is on disk: a crash mid-build must not leave a
  // sidecar claiming a wasm that was never written.
  const srcHash = sourceHash();
  writeFileSync(join(here, 'store-kernel.wasm.sources'), `${srcHash}\n`);
  console.log(`wrote browser/store-kernel.wasm (${wasm.length} bytes, sources ${srcHash.slice(0, 12)}…)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
