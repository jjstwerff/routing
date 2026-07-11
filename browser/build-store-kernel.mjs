// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// Regenerate browser/store-kernel.wasm — the loft-wasm base-map kernel the standalone app drives.
// Compiles client/web_basemap_kernel.loft with `loft --html` and extracts the embedded wasm (store-app.mjs
// loads it as a callable module via store-kernel.mjs). The .wasm is gitignored; run this when the kernel
// or the loft toolchain changes.  node browser/build-store-kernel.mjs   (needs loft on PATH, or $LOFT_BIN)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const loft = process.env.LOFT_BIN || 'loft';
const tmp = mkdtempSync(join(tmpdir(), 'store-kernel-'));
try {
  const html = join(tmp, 'k.html');
  execFileSync(loft, ['--html', html, '--lib', join(repo, 'lib'), join(repo, 'client/web_basemap_kernel.loft')], { stdio: 'inherit' });
  const m = readFileSync(html, 'utf8').match(/wasmB64="([A-Za-z0-9+/=]+)"/);
  if (!m) { console.error('no wasmB64 in the generated page'); process.exit(1); }
  const wasm = Buffer.from(m[1], 'base64');
  writeFileSync(join(here, 'store-kernel.wasm'), wasm);
  console.log(`wrote browser/store-kernel.wasm (${wasm.length} bytes)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
