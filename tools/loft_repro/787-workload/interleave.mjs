// A/B the two wasm runtimes with the arms INTERLEAVED and the order alternated, in ONE browser session
// per pair — the thing the original measurement did not do. Each arm loads its own copy of the site
// (identical but for store-kernel.wasm), prefetches the same pages, and times the same keyed load.
import { launch } from '/home/jurjens/workspace/routing/browser/cdp_transport.mjs';
import { readFileSync } from 'node:fs';
const [profile, base, storeUrl, keysFile, pagesFile, rate, rounds] = process.argv.slice(2);
const keys = readFileSync(keysFile, 'utf8').trim();
const pages = readFileSync(pagesFile, 'utf8').trim().split(',').map(Number);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ev = async (call, x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
const json = async (call, x) => { try { return JSON.parse(await ev(call, `JSON.stringify(${x})`) || 'null'); } catch { return null; } };

async function once(call, site) {
  await call('Page.navigate', { url: 'about:blank' }); await sleep(200);
  await call('Page.navigate', { url: `${base}/${site}/index.html` });
  for (let i = 0; i < 900; i++) { await sleep(100); if (await ev(call, '!!(window.__kernelForLazy)')) break; }
  await sleep(800);
  if (process.env.MODE === 'match') {
    // PURE COMPUTE: the matcher over data already resident, no paged read in it at all. If this is as
    // much slower as the keyed load, the loader is not where the difference lives.
    for (let i = 0; i < 400; i++) { await sleep(100); if (await ev(call, '!!(window.__perfHooks && window.__perfHooks.matchSpec)')) break; }
    if (+rate > 1) await call('Emulation.setCPUThrottlingRate', { rate: +rate });
    await sleep(300);
    const t0 = Date.now();
    await ev(call, `window.__perfHooks.matchSpec('52.2412299,6.8834496;52.2694705,6.9164085;52.3116272,6.9088554').then(()=>1)`);
    const msM = Date.now() - t0;
    if (+rate > 1) await call('Emulation.setCPUThrottlingRate', { rate: 1 });
    return msM;
  }
  await json(call, `window.__perfHooks.prefetch(${JSON.stringify(storeUrl)}, ${JSON.stringify(pages)})`);
  if (+rate > 1) await call('Emulation.setCPUThrottlingRate', { rate: +rate });
  await sleep(300);
  const cmd = `\n${storeUrl}\nkeysprobe\n${keys}\nbase\npaged\n\nwhole`;
  const t = Date.now();
  await ev(call, `window.__kernelForLazy.runKernel(${JSON.stringify(cmd)})`);
  const ms = Date.now() - t;
  if (+rate > 1) await call('Emulation.setCPUThrottlingRate', { rate: 1 });
  return ms;
}

const browser = await launch({ bin: 'chromium', userDataDir: profile });
const { call } = browser;
await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
await call('Network.setCacheDisabled', { cacheDisabled: true });
const A = [], B = [];
for (let r = 0; r < +rounds; r++) {
  // Alternate which arm goes FIRST each round, so run order cannot favour either.
  const order = r % 2 === 0 ? ['_siteA', '_siteB'] : ['_siteB', '_siteA'];
  for (const site of order) {
    const ms = await once(call, site);
    (site === '_siteA' ? A : B).push(ms);
    console.log(`  round ${r + 1}  ${site === '_siteA' ? 'main    ' : '74d02068'}  ${ms} ms`);
  }
}
browser.close();
const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`\n  main      median ${med(A)} ms   ${A.sort((x,y)=>x-y).join(' ')}`);
console.log(`  74d02068  median ${med(B)} ms   ${B.sort((x,y)=>x-y).join(' ')}`);
console.log(`  ⇒ ${(med(B) / med(A)).toFixed(2)}× at CPU ${rate}`);
