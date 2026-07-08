// Build the browser matcher from client/web_kernel.loft the loft-NATIVE way:
//   loft --html web_kernel.loft  →  a page whose wasm uses loft's own host_input()/println channel.
// We only need the raw wasm out of it — the page (index.html) loads it directly with a tiny 4-import
// shim (loft_io: print + input queue, one asset stub). No jco, no npm deps, no WASI.
//   LOFT_BIN=... node browser/build.mjs        (default loft = whatever `loft` resolves to on PATH)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const loft = process.env.LOFT_BIN || 'loft';
const loftRoot = process.env.LOFT_ROOT || resolve(repo, '../loft');
const html = join(here, '.web_kernel.html');

console.log('loft --html client/web_kernel.loft …');
execFileSync(loft, ['--html', html, '--path', loftRoot + '/', '--lib', join(repo, 'lib'),
  join(repo, 'client/web_kernel.loft')], { stdio: 'inherit', env: { ...process.env, LOFT_TIMEOUT: '300' } });

const src = readFileSync(html, 'utf8');
const m = src.match(/wasmB64\s*=\s*"([A-Za-z0-9+/=]+)"/);
if (!m) throw new Error('wasmB64 not found in --html output (loft output format changed?)');
const wasm = Buffer.from(m[1], 'base64');
writeFileSync(join(here, 'web_kernel.wasm'), wasm);
rmSync(html, { force: true });
console.log(`wrote browser/web_kernel.wasm (${(wasm.length / 1024 | 0)} KB) — serve with: node browser/serve.mjs`);
