// Rebuild the browser matcher module from source:
//   client/app_kernel.loft  --(loft --native-wasm)-->  app_kernel.wasm (wasip2 component)
//                           --(jco transpile)------->  gen/ (browser-ready ESM + core wasm)
// Requires the loft toolchain (LOFT_BIN or ../loft/target/release/loft) and installed devDeps.
//   npm --prefix browser install && npm --prefix browser run build
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const loft = process.env.LOFT_BIN || resolve(repo, '../loft/target/release/loft');
const loftRoot = process.env.LOFT_ROOT || resolve(repo, '../loft');
const wasm = join(here, 'app_kernel.wasm');

console.log('1/2  loft --native-wasm  → app_kernel.wasm');
execFileSync(loft, ['--native-wasm', wasm, '--path', loftRoot + '/', '--lib', join(repo, 'lib'),
  join(repo, 'client/app_kernel.loft')], { stdio: 'inherit', env: { ...process.env, LOFT_TIMEOUT: '300' } });

console.log('2/2  jco transpile       → gen/');
execFileSync(join(here, 'node_modules/.bin/jco'),
  ['transpile', wasm, '-o', join(here, 'gen'), '--name', 'app_kernel'], { stdio: 'inherit' });

console.log('done → browser/gen/  (open with: node browser/serve.mjs, then http://127.0.0.1:8099/browser/)');
