// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// The page index, written by python and read by JS — proven to be the SAME index. Run:
//   node browser/page-index.test.mjs
//
// WHY THIS GATE EXISTS, AND WHAT IT ALREADY CAUGHT. The writer computing an offset and the reader
// trusting it are two separate claims, and they disagreed: `build_coverage_index.py` declared a 40-byte
// header beside a 36-byte `struct.pack`, so every sub-directory and chunk offset pointed 4 bytes past its
// own data. Nothing failed. A page number is only a fetch HINT — wrong ones cost bytes, never a wrong map
// (docs/prefetch-index-design.md §5.2) — so a completely garbled index degrades to exactly the behaviour
// it exists to replace, silently, and the app still draws. The only way that surfaces is a test that
// reads the bytes back and insists on the pages that went in.
//
// It is hermetic: it builds its own fixture, runs the real builder over it, and serves the result through
// a `fetch` stub that honours `Range` exactly as a host does. So it needs no data, no network and no
// browser, and it can assert what a live profile cannot — HOW MANY reads a session costs and where they
// land, which is the entire claim of the two-level directory.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { configureIndex, pagesFor, indexStats, openIndex } from './page-index.mjs';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };
// A page list runs to hundreds of numbers, so equality REPORTS a digest and only spills the values when
// it fails — a passing line nobody can read is how a wrong one goes unnoticed.
const brief = (v) => (Array.isArray(v) && v.length > 8 ? `[${v.length}: ${v.slice(0, 3)}…${v.slice(-1)}]` : JSON.stringify(v));
const eq = (a, b, msg) => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  ok(same, same ? `${msg}  ${brief(a)}` : `${msg}\n      got  ${JSON.stringify(a)}\n      want ${JSON.stringify(b)}`);
};
const here = new URL('.', import.meta.url).pathname;
const repo = join(here, '..');

// ── the fixture ────────────────────────────────────────────────────────────────────────────────────
// Two stores over the SAME ground, which is the case v3 exists for: a viewport is answered by a base
// layer and a roads layer at once, and their cells must come out of one chunk read rather than two
// indexes. The cells are a regular lattice only so the expected answer is computable by hand — the index
// never sees that regularity, it buckets by density like any other input.
const work = mkdtempSync(join(tmpdir(), 'page-index-'));
mkdirSync(join(work, 'blocks'), { recursive: true });
mkdirSync(join(work, 'browser'), { recursive: true });

const STEP = 400000;                       // 0.04° between cells, as the real tiles are
const LO0 = 40000000, LA0 = 505000000;     // 4.0°E, 50.5°N — inside the index's -11°E/34°N origin
const NX = 40, NY = 40;                    // 1 600 cells per store, over 1.6° × 1.6° (four root tiles)
const sha = (s) => createHash('sha256').update(s).digest('hex');

const cellsOf = (seed) => {
  const cells = {}, xy = {};
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const key = String(1000000 + j * NX + i);
    // Pages that vary per cell AND per store, so a leak between stores or between cells is visible in the
    // answer rather than hidden by two cells happening to want the same page.
    cells[key] = [seed + i, seed + 1000 + j, seed + 2000 + ((i * 7 + j * 13) % 97)];
    xy[key] = [LO0 + i * STEP, LA0 + j * STEP];
  }
  return { cells, xy };
};
const STORES = [
  { name: 'fix-a.base.store', url: 'stores/fix-a.base.store', seed: 10000 },
  { name: 'fix-b.roads.store', url: 'https://example.invalid/data/fix-b.roads.store', seed: 20000 },
];
for (const st of STORES) {
  st.sha = sha(st.name);
  const { cells, xy } = cellsOf(st.seed);
  st.cells = cells; st.xy = xy;
  writeFileSync(join(work, 'blocks', `${st.name}.pages.json`),
    JSON.stringify({ block: st.name, sha256: st.sha, bytes: 1 << 20, page: 65536, record: 'PTile', cells, xy }));
}
writeFileSync(join(work, 'browser', 'coverage.json'), JSON.stringify({
  version: 1, unit: 1e7,
  blocks: [{ id: 'fix', base: { url: STORES[0].url, sha256: STORES[0].sha }, roads: { url: STORES[1].url, sha256: STORES[1].sha } }],
}));

// MAX_CELLS small on purpose: 3 200 cells over four root tiles must SPLIT, and a reader that computes a
// leaf's box from its level is only exercised when the leaves sit at more than one level.
let build = '';
try {
  build = execFileSync('python3', [join(repo, 'tools', 'build_coverage_index.py'),
                                   'blocks/coverage.pagesx', '--max-cells=200'],
                       { cwd: work, encoding: 'utf8' });
} catch (e) {
  // The builder verifies its own output by re-reading it, so this is the FIRST place the 4-byte header
  // slip surfaced. Report it as a failed check rather than a stack trace: the reader's checks below
  // catch the same class independently, and seeing both is what says which side moved.
  console.error(`  ✗ tools/build_coverage_index.py failed:\n${String(e.stdout || e.message).trimEnd()}`);
  process.exit(1);
}
console.log(build.trimEnd().split('\n').map((l) => '    ' + l.trim()).join('\n'));
const IX = readFileSync(join(work, 'blocks', 'coverage.pagesx'));
ok(/levels: .*L[1-9]/.test(build), 'the fixture forces a quadtree deeper than level 0');

// ── the host ───────────────────────────────────────────────────────────────────────────────────────
// A `Range` is answered exactly as GitHub Pages answers it: 206 with the requested slice, clamped at EOF.
// Every read is recorded, because "how many round trips does a session cost" is the claim under test and
// a timing cannot see it.
const reads = [];
const BASE = 'https://host.invalid/';
globalThis.fetch = async (url, opts) => {
  const m = /^bytes=(\d+)-(\d+)$/.exec((opts && opts.headers && opts.headers.Range) || '');
  if (String(url) !== BASE + 'coverage.pagesx') return { ok: false, status: 404 };
  if (!m) return { ok: false, status: 400 };
  const off = +m[1], end = Math.min(+m[2], IX.length - 1);
  if (off >= IX.length) return { ok: false, status: 416 };
  reads.push([off, end - off + 1]);
  const slice = IX.subarray(off, end + 1);
  return { ok: true, status: 206, headers: { get: () => null },
           arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) };
};

const SITE = 'https://app.invalid/';
const resolved = STORES.map((s) => new URL(s.url, SITE).href);
configureIndex(BASE + 'coverage.pagesx', STORES.map((s, i) => [resolved[i], s.sha]));

// The pages a box SHOULD produce, computed from the fixture rather than from the index — otherwise the
// test proves only that the reader agrees with itself.
const expected = (st, box, pad = 0) => {
  const out = new Set();
  for (const k of Object.keys(st.cells)) {
    const [ox, oy] = st.xy[k];
    if (ox < box.mnlo - pad || ox > box.mxlo + pad || oy < box.mnla - pad || oy > box.mxla + pad) continue;
    for (const p of st.cells[k]) out.add(p);
  }
  return [...out].sort((a, b) => a - b);
};
const got = async (i, box, pad) => (await pagesFor(resolved[i], box, pad)).sort((a, b) => a - b);

console.log('\nV3 · the session prologue is ONE read');
await openIndex();
eq(reads.length, 1, 'header + store table + root directory cost one range read');
ok(reads[0][0] === 0, 'and it starts at byte 0');
const st0 = indexStats();
eq(st0.stores, STORES.map((s) => s.name), 'both stores are in the table');
eq(st0.cells, 2 * NX * NY, 'every fixture cell reached the index');

console.log('\nV3 · a viewport gets exactly the pages its cells hold');
// A quarter-degree box in the middle: six or seven cells a side, well inside one root tile.
const box = { mnlo: LO0 + 10 * STEP, mxlo: LO0 + 16 * STEP, mnla: LA0 + 10 * STEP, mxla: LA0 + 16 * STEP };
const a = await got(0, box, 0);
ok(a.length > 0, `the read is not vacuous — ${a.length} pages`);
eq(a, expected(STORES[0], box), 'store A: page-for-page what the fixture put in those cells');
const afterA = reads.length;

console.log('\nV3 · the SECOND store of the same viewport costs no extra read');
const b = await got(1, box, 0);
eq(b, expected(STORES[1], box), 'store B: its own pages, from the same chunks');
eq(reads.length, afterA, 'zero further range reads — one index, one chunk, every store');
ok(!a.some((p) => b.includes(p)), 'and no page leaked between the two stores');

console.log('\nV3 · a box that spans root tiles and leaf levels is still complete');
const wide = { mnlo: LO0, mxlo: LO0 + (NX - 1) * STEP, mnla: LA0, mxla: LA0 + (NY - 1) * STEP };
eq(await got(0, wide, 0), expected(STORES[0], wide), 'the whole fixture extent, across every leaf');
const stWide = indexStats();
ok(stWide.subdirsHeld > 1, `more than one sub-directory was read (${stWide.subdirsHeld})`);
ok(stWide.chunkReads > 1, `more than one leaf chunk was read (${stWide.chunkReads})`);

console.log('\nV3 · pad widens the CELL test, not just the chunk test');
const tight = { mnlo: LO0 + 20 * STEP, mxlo: LO0 + 20 * STEP, mnla: LA0 + 20 * STEP, mxla: LA0 + 20 * STEP };
const one = await got(0, tight, 0);
eq(one, expected(STORES[0], tight), 'a degenerate box reads exactly one cell');
const padded = await got(0, tight, STEP);
eq(padded, expected(STORES[0], tight, STEP), 'padded by one cell it reads the 3×3 around it');
ok(padded.length > one.length, `and that is strictly more pages (${one.length} → ${padded.length})`);

console.log('\nV3 · an index that does not match the data is REFUSED, not believed');
configureIndex(BASE + 'coverage.pagesx', [[resolved[0], sha('some other bytes')], [resolved[1], STORES[1].sha]]);
eq(await got(0, box, 0), [], 'a store whose sha256 disagrees prefetches nothing (§5.1)');
ok(indexStats().refusedSha.length === 1, 'and says so, once, at the chokepoint');
eq(await got(1, box, 0), expected(STORES[1], box), 'the store that DOES match is unaffected');

console.log('\nV3 · everything unknown degrades to the old read path');
eq(await pagesFor(SITE + 'stores/never-indexed.store', box, 0), [], 'a store the index does not name → []');
ok(indexStats().unknownStores.length === 1, 'and it is reported rather than silent');
configureIndex(BASE + 'missing.pagesx', []);
eq(await pagesFor(resolved[0], box, 0), [], 'no index file at all → [] (the app then reads as it always did)');
configureIndex(null, []);
eq(await pagesFor(resolved[0], box, 0), [], 'no index configured → []');

rmSync(work, { recursive: true, force: true });
console.log(fails ? `\n  FAIL: ${fails} check(s)` : '\n  ALL PAGE-INDEX CHECKS PASS');
process.exit(fails ? 1 : 0);
