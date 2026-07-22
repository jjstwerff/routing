// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-BUILD — build the deployable GitHub Pages site (node only; no loft, no network). Inlines map.mjs +
// store-kernel.mjs + store-app.mjs into a single _site/index.html (no external .mjs → no Pages MIME
// surprises), and copies the store-app kernel wasm + the two loft stores. At runtime the app fetches the
// stores + the wasm by relative URL and reads them with loft-wasm: `view <bbox>` → base map, `match` →
// route, on a 2D canvas — no server.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..', '_site');
const stripExport = (s) => s.replace(/^export\s+/gm, '');

// Inline the ES modules into index.html as one module script (strip `export`, drop the imports).
// ORDER MATTERS — the modules are concatenated into a single flat scope, so a module must follow the
// one it reads from: loft-deliver (loft's vendored reader) before loft-store (which calls it), and both
// before store-app. `stripExport` also turns loft-deliver's trailing `export { readLoftValue };` into a
// harmless block statement, which is the embedding upstream designed that line for.
const loftDeliverJs = stripExport(readFileSync(join(here, 'loft-deliver.js'), 'utf8'));
const loftStoreMjs = stripExport(readFileSync(join(here, 'loft-store.mjs'), 'utf8'))
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/loft-deliver\.js';\s*$/m, '');
const mapMjs = stripExport(readFileSync(join(here, 'map.mjs'), 'utf8'));
const storeKernelMjs = stripExport(readFileSync(join(here, 'store-kernel.mjs'), 'utf8'));
const storeAppMjs = stripExport(readFileSync(join(here, 'store-app.mjs'), 'utf8'))
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/map\.mjs';\s*$/m, '')
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/store-kernel\.mjs';\s*$/m, '')
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/loft-store\.mjs';\s*$/m, '');
// A leftover `import ... from './x.mjs'` means a module was added without teaching this bundler about
// it: the browser then tries to FETCH that path out of _site/, where it does not exist, and the app dies
// on load with no console error the harness can see. Fail the build instead.
for (const [name, src] of [['store-app.mjs', storeAppMjs], ['loft-store.mjs', loftStoreMjs]]) {
  const stray = src.match(/^import\s.*$/m);
  if (stray) { console.error(`build-site: ERROR — un-inlined import left in ${name}: ${stray[0]}`); process.exit(1); }
}
const html = readFileSync(join(here, 'index.html'), 'utf8')
  .replace(/<script type="module" src="\.\/store-app\.mjs"><\/script>/,
    `<script type="module">\n/* ---- inlined browser/loft-deliver.js ---- */\n${loftDeliverJs}\n/* ---- inlined browser/loft-store.mjs ---- */\n${loftStoreMjs}\n/* ---- inlined browser/map.mjs ---- */\n${mapMjs}\n/* ---- inlined browser/store-kernel.mjs ---- */\n${storeKernelMjs}\n/* ---- inlined browser/store-app.mjs ---- */\n${storeAppMjs}\n</script>`);

// Assemble _site/: the inlined app + the kernel wasm + the two loft stores (served static for the app to fetch).
if (existsSync(site)) rmSync(site, { recursive: true });
mkdirSync(site);
writeFileSync(join(site, 'index.html'), html);
if (existsSync(join(here, 'store-kernel.wasm'))) cpSync(join(here, 'store-kernel.wasm'), join(site, 'store-kernel.wasm'));
else console.log('build-site: WARNING — browser/store-kernel.wasm missing (run: node browser/build-store-kernel.mjs)');
if (existsSync(join(here, 'stores'))) cpSync(join(here, 'stores'), join(site, 'stores'), { recursive: true });
console.log(`build-site: _site/index.html (${(html.length / 1024) | 0} KB, inlined) + _site/store-kernel.wasm + _site/stores/`);
