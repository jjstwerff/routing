// Node smoke test: run the jco-transpiled matcher component and let it print its route.
// Validates the transpiled wasm under a JS WASI host before wiring the browser page.
// The Node shim uses real node:fs but preopens nothing by default — so we preopen the repo
// root and drive the component with args, exactly like the browser will (there via _setFileData).
//   node smoke.mjs [dataset-path-relative-to-repo-root]
import { _setArgs, _setCwd } from '@bytecodealliance/preview2-shim/cli';
import { _setPreopens } from '@bytecodealliance/preview2-shim/filesystem';
import { run } from './gen/app_kernel.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = process.argv[2] ?? 'lib/routing_kernel/tests/fixtures/real_stretch.json';

_setPreopens({ '/': repoRoot });                 // virtual "/" → real repo root
_setCwd('/');                                    // #cwd resolves the relative arg against "/"
_setArgs(['app_kernel', data]);                  // loft does env::args().skip(1) → sees [data]

try {
  run.run();                                     // wasi:cli/run entry; prints to process.stdout
} catch (e) {
  if (e?.constructor?.name !== 'ComponentExit' || e.code) throw e;  // clean exit(0) only
}
