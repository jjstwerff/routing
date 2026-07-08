// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-MAP M5 — build the deployable GitHub Pages site (node only; no loft, no network). Bakes the tile
// pyramid from the committed layer text, then inlines map.mjs + tiles.mjs into a single _site/index.html
// (so there are no external .mjs files → no GitHub-Pages MIME surprises, fewer requests) + copies tiles/.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..', '_site');

// 1. Bake the tile pyramid from browser/*.txt → browser/tiles/.
execFileSync('node', [join(here, 'bake_tiles.mjs')], { stdio: 'inherit' });

// 2. Inline the two ES modules into index.html as one module script (strip `export`, drop the cross-import).
const stripExport = (s) => s.replace(/^export\s+/gm, '');
const mapMjs = stripExport(readFileSync(join(here, 'map.mjs'), 'utf8'));
const tilesMjs = stripExport(readFileSync(join(here, 'tiles.mjs'), 'utf8'))
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/map\.mjs';\s*$/m, '');
const html = readFileSync(join(here, 'index.html'), 'utf8')
  .replace(/^\s*import\s+\{[^}]*\}\s+from\s+'\.\/map\.mjs';\s*$/m, '')
  .replace(/^\s*import\s+\{[^}]*\}\s+from\s+'\.\/tiles\.mjs';\s*$/m, '')
  .replace(/<script type="module">/, `<script type="module">\n/* ---- inlined browser/map.mjs ---- */\n${mapMjs}\n/* ---- inlined browser/tiles.mjs ---- */\n${tilesMjs}\n/* ---- app ---- */`);

// 3. Assemble _site/: index.html + the tile pyramid.
if (existsSync(site)) rmSync(site, { recursive: true });
mkdirSync(site);
writeFileSync(join(site, 'index.html'), html);
cpSync(join(here, 'tiles'), join(site, 'tiles'), { recursive: true });
console.log(`build-site: _site/index.html (${(html.length / 1024) | 0} KB, inlined) + _site/tiles/`);
