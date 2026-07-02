// Drive the app in headless Chromium over the DevTools protocol (no puppeteer — node's built-in
// WebSocket) and verify the elevation dock (PLAN step 15): closed by default, opens on toggle,
// requests the profile over the app's own WS, draws it (canvas pixels), totals ↑100/↓0.
// Usage: node tools/cdp_elev.mjs [devtools-host:port] [app-origin]
const dt = process.argv[2] || "127.0.0.1:9222";
const app = process.argv[3] || "http://127.0.0.1:18080";

const targets = await (await fetch(`http://${dt}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.startsWith(app));
if (!page) { console.log("FAIL: no app page target", targets.map((t) => t.url)); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (method, params) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id); }
});
await new Promise((res) => ws.addEventListener("open", res));

const driver = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  out.closedByDefault = document.getElementById("elev-dock").classList.contains("hidden");
  for (let i = 0; i < 100 && !(routing.ws && routing.ws.connected); i++) await sleep(100);
  out.wsConnected = routing.ws.connected;
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
ws.close();
const v = r.result && r.result.result && r.result.result.value;
if (!v) { console.log("FAIL: evaluate error", JSON.stringify(r.result, null, 2).slice(0, 600)); process.exit(1); }
const o = JSON.parse(v);
console.log("RESULT", v);
const ok = o.closedByDefault && o.wsConnected && o.dockOpen
  && /↑ 100 m/.test(o.totals) && /↓ 0 m/.test(o.totals) && o.filledPx > 1000
  && o.crosshairPx > 50;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
