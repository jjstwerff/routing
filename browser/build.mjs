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
console.log(`wrote browser/web_kernel.wasm (${(wasm.length / 1024 | 0)} KB)`);

// Terrain fills (PLAN-BASEMAP S7): classify the area fixture in loft and emit one polygon per line for the
// browser's "Terrain (our data)" base. Reproducible from the committed sample.
const areasFixture = process.env.AREAS || join(repo, 'client/basemap/fixtures/real_stretch_areas.sample.json');
console.log('loft emit_areas → browser/areas.txt …');
const areas = execFileSync(loft, ['--interpret', '--path', loftRoot + '/', '--lib', join(repo, 'lib'),
  join(repo, 'client/basemap/emit_areas.loft'), areasFixture], { encoding: 'utf8', env: { ...process.env, LOFT_TIMEOUT: '300' } });
writeFileSync(join(here, 'areas.txt'), areas);
console.log(`wrote browser/areas.txt (${(areas.length / 1024 | 0)} KB, ${areas.trim().split('\n').length} areas)`);

// Building footprints (PLAN-BASEMAP S8): one ring per line for the "Terrain (our data)" base.
const bldFixture = process.env.BUILDINGS || join(repo, 'client/basemap/fixtures/real_stretch_buildings.sample.json');
console.log('loft emit_buildings → browser/buildings.txt …');
const bld = execFileSync(loft, ['--interpret', '--path', loftRoot + '/', '--lib', join(repo, 'lib'),
  join(repo, 'client/basemap/emit_buildings.loft'), bldFixture], { encoding: 'utf8', env: { ...process.env, LOFT_TIMEOUT: '300' } });
writeFileSync(join(here, 'buildings.txt'), bld);
console.log(`wrote browser/buildings.txt (${(bld.length / 1024 | 0)} KB, ${bld.trim().split('\n').length} buildings)`);

// Place labels (PLAN-BASEMAP S9): rank;name;lat,lon — the browser sizes + zoom-gates them.
const placesFixture = process.env.PLACES || join(repo, 'client/basemap/fixtures/real_stretch_places.json');
console.log('loft emit_places → browser/places.txt …');
const places = execFileSync(loft, ['--interpret', '--path', loftRoot + '/', '--lib', join(repo, 'lib'),
  join(repo, 'client/basemap/emit_places.loft'), placesFixture], { encoding: 'utf8', env: { ...process.env, LOFT_TIMEOUT: '300' } });
writeFileSync(join(here, 'places.txt'), places);
console.log(`wrote browser/places.txt (${places.trim().split('\n').length} places)`);

// Street-name centerlines (PLAN-BASEMAP S10): name;lat,lon;... — the browser labels along + repeats on zoom.
const streetsFixture = process.env.STREETS || join(repo, 'client/basemap/fixtures/real_stretch_streets.sample.json');
console.log('loft emit_streets → browser/streets.txt …');
const streets = execFileSync(loft, ['--interpret', '--path', loftRoot + '/', '--lib', join(repo, 'lib'),
  join(repo, 'client/basemap/emit_streets.loft'), streetsFixture], { encoding: 'utf8', env: { ...process.env, LOFT_TIMEOUT: '300' } });
writeFileSync(join(here, 'streets.txt'), streets);
console.log(`wrote browser/streets.txt (${(streets.length / 1024 | 0)} KB, ${streets.trim().split('\n').length} streets)`);

// Data-freshness stamp (PLAN-BASEMAP S12): the OSM snapshot the presentation data was cut from
// (osm3s.timestamp_osm_base, stamped by Overpass). The app shows "data as of …" from this.
const stampSrc = JSON.parse(readFileSync(placesFixture, 'utf8'));
const stamp = ((stampSrc.osm3s || {}).timestamp_osm_base || '').slice(0, 10);
writeFileSync(join(here, 'stamp.txt'), stamp);
console.log(`wrote browser/stamp.txt ("${stamp}") — serve with: node browser/serve.mjs`);
