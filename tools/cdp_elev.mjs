// Drive the app in headless Chromium over the DevTools protocol (no puppeteer — node's built-in
// WebSocket) and verify the elevation dock (PLAN step 15): closed by default, opens on toggle,
// requests the profile over the app's own WS, draws it (canvas pixels), totals ↑100/↓0.
// Usage: node tools/cdp_elev.mjs [profile-dir] [app-origin]
import { launch } from "../browser/cdp_transport.mjs";
const profile = process.argv[2];
const app = process.argv[3] || "http://127.0.0.1:18080";

// Opened ON the app, as the old gate did by passing the url to chromium — this driver's checks assume
// the page is already the app rather than about:blank.
const browser = await launch({
  bin: process.env.CHROMIUM_BIN || "chromium", userDataDir: profile, url: app + "/", clearStorage: false, windowSize: null, settleMs: 4000,
});
const { call } = browser;

const driver = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  out.closedByDefault = document.getElementById("elev-dock").classList.contains("hidden");
  for (let i = 0; i < 100 && !(routing.ws && routing.ws.connected); i++) await sleep(100);
  out.wsConnected = routing.ws.connected;
  routing.map.setView([52.0, 4.985], 13);   // the terrain zoom follows the map zoom; fixture is z13
  await sleep(300);
  const route = [];
  for (let i = 0; i <= 30; i++) route.push({ lat: 52.0, lon: 4.97 + (0.03 * i) / 30 });
  document.getElementById("elev-toggle").click();
  routing.elevation.onMatched(route);
  let txt = "";
  for (let i = 0; i < 100; i++) {
    txt = document.getElementById("elev-totals").textContent;
    if (/\\u2191/.test(txt)) break;
    await sleep(100);
  }
  out.totals = txt;
  out.dockOpen = !document.getElementById("elev-dock").classList.contains("hidden");
  const c = document.getElementById("elev-canvas");
  const count = () => {
    let n = 0;
    const img = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < img.length; i += 4) if (img[i] > 0) n++;
    return n;
  };
  out.filledPx = count();
  // Crosshair: a pointer over the chart adds the hairline + dot + label pixels.
  const rect = c.getBoundingClientRect();
  c.dispatchEvent(new PointerEvent("pointermove", {
    clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5, bubbles: true,
  }));
  await sleep(200);
  out.crosshairPx = count() - out.filledPx;
  return JSON.stringify(out);
})()`;

const r = await call("Runtime.evaluate", { expression: driver, awaitPromise: true, returnByValue: true });
const v = r.result && r.result.result && r.result.result.value;
if (!v) { console.log("FAIL: evaluate error", JSON.stringify(r.result, null, 2).slice(0, 600)); process.exit(1); }
const o = JSON.parse(v);
console.log("RESULT", v);

// The dock was opened above — its state is remembered per-browser, so a reload keeps it open.
await call("Page.reload");
await new Promise((res) => setTimeout(res, 4000));
const r2 = await call("Runtime.evaluate", { expression: `(async () => {
  const sleep = (ms) => new Promise((r3) => setTimeout(r3, ms));
  for (let i = 0; i < 100 && typeof window.routing === "undefined"; i++) await sleep(100);
  return JSON.stringify({ openAfterReload: !document.getElementById("elev-dock").classList.contains("hidden") });
})()`, awaitPromise: true, returnByValue: true });
browser.close();
const o2 = JSON.parse(r2.result.result.value);
console.log("RELOAD", JSON.stringify(o2));

const ok = o.closedByDefault && o.wsConnected && o.dockOpen
  && /↑ 100 m/.test(o.totals) && /↓ 0 m/.test(o.totals) && o.filledPx > 1000
  && o.crosshairPx > 50
  && o2.openAfterReload;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
