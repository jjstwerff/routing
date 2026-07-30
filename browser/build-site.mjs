// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-BUILD — build the deployable GitHub Pages site (node only; no loft, no network). Inlines map.mjs +
// store-kernel.mjs + store-app.mjs into a single _site/index.html (no external .mjs → no Pages MIME
// surprises), and copies the store-app kernel wasm + the two loft stores. At runtime the app fetches the
// stores + the wasm by relative URL and reads them with loft-wasm: `view <bbox>` → base map, `match` →
// route, on a 2D canvas — no server.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync, readdirSync, statSync } from 'node:fs';
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
const storeGeomMjs = stripExport(readFileSync(join(here, 'store-geom.mjs'), 'utf8'));
const mapMjs = stripExport(readFileSync(join(here, 'map.mjs'), 'utf8'))
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/store-geom\.mjs';\s*$/m, '');
const roughMjs = stripExport(readFileSync(join(here, 'rough.mjs'), 'utf8'));
// PLAN-SCALE S7 — the coverage resolver (index → block). Pure, no imports of its own.
const coverageMjs = stripExport(readFileSync(join(here, 'coverage.mjs'), 'utf8'));
const storeKernelMjs = stripExport(readFileSync(join(here, 'store-kernel.mjs'), 'utf8'));
const storeAppMjs = stripExport(readFileSync(join(here, 'store-app.mjs'), 'utf8'))
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/map\.mjs';\s*$/m, '')
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/store-kernel\.mjs';\s*$/m, '')
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/store-geom\.mjs';\s*$/m, '')
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/loft-store\.mjs';\s*$/m, '')
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/rough\.mjs';\s*$/m, '')
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/coverage\.mjs';\s*$/m, '');
// A leftover `import ... from './x.mjs'` means a module was added without teaching this bundler about
// it: the browser then tries to FETCH that path out of _site/, where it does not exist, and the app dies
// on load with no console error the harness can see. Fail the build instead.
for (const [name, src] of [['store-app.mjs', storeAppMjs], ['loft-store.mjs', loftStoreMjs], ['map.mjs', mapMjs], ['store-geom.mjs', storeGeomMjs], ['rough.mjs', roughMjs], ['coverage.mjs', coverageMjs]]) {
  const stray = src.match(/^import\s.*$/m);
  if (stray) { console.error(`build-site: ERROR — un-inlined import left in ${name}: ${stray[0]}`); process.exit(1); }
}
const html = readFileSync(join(here, 'index.html'), 'utf8')
  .replace(/<script type="module" src="\.\/store-app\.mjs"><\/script>/,
    `<script type="module">\n/* ---- inlined browser/loft-deliver.js ---- */\n${loftDeliverJs}\n/* ---- inlined browser/loft-store.mjs ---- */\n${loftStoreMjs}\n/* ---- inlined browser/store-geom.mjs ---- */\n${storeGeomMjs}\n/* ---- inlined browser/map.mjs ---- */\n${mapMjs}\n/* ---- inlined browser/rough.mjs ---- */\n${roughMjs}\n/* ---- inlined browser/coverage.mjs ---- */\n${coverageMjs}\n/* ---- inlined browser/store-kernel.mjs ---- */\n${storeKernelMjs}\n/* ---- inlined browser/store-app.mjs ---- */\n${storeAppMjs}\n</script>`);

// Assemble _site/: the inlined app + the kernel wasm + the two loft stores (served static for the app to fetch).
if (existsSync(site)) rmSync(site, { recursive: true });
mkdirSync(site);
writeFileSync(join(site, 'index.html'), html);
if (existsSync(join(here, 'store-kernel.wasm'))) cpSync(join(here, 'store-kernel.wasm'), join(site, 'store-kernel.wasm'));
else console.log('build-site: WARNING — browser/store-kernel.wasm missing (run: node browser/build-store-kernel.mjs)');
if (existsSync(join(here, 'stores'))) cpSync(join(here, 'stores'), join(site, 'stores'), { recursive: true });
// The coverage index the app resolves against (PLAN-SCALE S7). Committed rather than generated here: it
// measures extents and hashes out of the stores, which needs loft, and the Pages deploy job has none. Its
// absence is not subtle — the app boots to "no coverage index — the app has no data to show", which is
// exactly what the deployed site did between S7 landing and this line existing.
if (existsSync(join(here, 'coverage.json'))) cpSync(join(here, 'coverage.json'), join(site, 'coverage.json'));
else console.log('build-site: WARNING — no browser/coverage.json; the app will have no data (run tools/build_index.sh)');
// Generated blocks (tools/build-blocks.sh → blocks/, gitignored) land in the same place, so the coverage
// index can name every block with one kind of URL. They are copied rather than committed: a country block
// is ~300 MB and is rebuilt from OSM, so it is output, not source.
const blocks = join(here, '..', 'blocks');
if (existsSync(blocks)) {
  // Only SMALL blocks ship beside the app. A country block is published as a release asset and named by
  // an absolute URL in the index (PLAN-SCALE §7 R6), so copying it here would add gigabytes to every
  // site build and every gate run for a file the page never fetches from this origin.
  const LIMIT = 64 * 1024 * 1024;
  for (const f of readdirSync(blocks)) {
    const p = join(blocks, f);
    if (statSync(p).size <= LIMIT) cpSync(p, join(site, 'stores', f));
  }
}
console.log(`build-site: _site/index.html (${(html.length / 1024) | 0} KB, inlined) + _site/store-kernel.wasm + _site/stores/`);
