// Build a SINGLE-FILE standalone app: browser/standalone.html.
//
// Takes the same UI as index.html but inlines the wasm (base64) and the test-set JSON as
// window.__STANDALONE, so the page runs from one file with NO server and NO network — double-click
// it (file://) or drop it on any static host. index.html's embedded-mode branch reads the inlined
// assets instead of fetching; the service worker + IndexedDB paths are skipped.
//
//   LOFT_BIN=... node browser/build-standalone.mjs     (default loft = whatever `loft` resolves to)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const loft = process.env.LOFT_BIN || 'loft';
const loftRoot = process.env.LOFT_ROOT || resolve(repo, '../loft');
const dataFile = process.env.DATASET || join(repo, 'lib/routing_kernel/tests/fixtures/real_stretch.json');
const htmlTmp = join(here, '.web_kernel.html');
const out = join(here, 'standalone.html');

// 1. loft --html → a self-contained page; we want the base64 wasm out of it (already base64, no re-encode).
console.log('loft --html client/web_kernel.loft …');
execFileSync(loft, ['--html', htmlTmp, '--path', loftRoot + '/', '--lib', join(repo, 'lib'),
  join(repo, 'client/web_kernel.loft')], { stdio: 'inherit', env: { ...process.env, LOFT_TIMEOUT: '300' } });
const wasmB64 = (readFileSync(htmlTmp, 'utf8').match(/wasmB64\s*=\s*"([A-Za-z0-9+/=]+)"/) || [])[1];
rmSync(htmlTmp, { force: true });
if (!wasmB64) throw new Error('wasmB64 not found in --html output (loft output format changed?)');

// 2. The test set (raw JSON text — the page hands loft the bytes and also parses it for the network view).
const dataset = readFileSync(dataFile, 'utf8');

// 3. Inject both into index.html as window.__STANDALONE, before the module script runs.
//    JSON.stringify makes valid JS; escaping `<` keeps the payload </script>-safe.
const payload = JSON.stringify({ wasmB64, dataset }).replace(/</g, '\\u003c');
const inject = `<script>window.__STANDALONE=${payload};</script>\n`;
const page = readFileSync(join(here, 'index.html'), 'utf8');
if (!page.includes('</head>')) throw new Error('index.html has no </head> to inject before');
writeFileSync(out, page.replace('</head>', inject + '</head>'));

const kb = (n) => (n / 1024) | 0;
console.log(`wrote browser/standalone.html (${kb(readFileSync(out).length)} KB` +
  ` — wasm ${kb(Buffer.from(wasmB64, 'base64').length)} KB + data ${kb(dataset.length)} KB inline).`);
console.log('Open it directly in a browser — no server needed.');
