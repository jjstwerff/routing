// Node WebSocket check for the elevation profile (PLAN step 15).
// Sends a detailed route crossing the synthetic step tile (see make_terrarium_tile.loft) and
// expects "11:<up>|<down>|<d,e;…>" with up≈100, down≈0, a west end at 100 m and an east end at 200 m.
// Usage: node tools/ws_elevation.mjs [ws://host:port/ws]
const url = process.argv[2] || "ws://127.0.0.1:18080/ws";
const ws = new WebSocket(url);
let got = false;
const timer = setTimeout(() => { if (!got) { console.log("TIMEOUT (no reply in 15s)"); process.exit(3); } }, 15000);

ws.addEventListener("open", () => ws.send("10:52.0,4.97;52.0,5.0"));
ws.addEventListener("message", (e) => {
  got = true; clearTimeout(timer);
  const raw = e.data.toString();
  const i = raw.indexOf(":");
  const id = raw.slice(0, i);
  const [up, down, prof] = raw.slice(i + 1).split("|");
  const samples = prof ? prof.split(";").filter(Boolean) : [];
  const first = samples.length ? samples[0].split(",").map(Number) : [];
  const last = samples.length ? samples[samples.length - 1].split(",").map(Number) : [];
  const ok = id === "11"
    && Math.abs(parseFloat(up) - 100) < 0.5
    && Math.abs(parseFloat(down)) < 0.5
    && samples.length >= 20
    && Math.abs(first[1] - 100) < 0.5
    && Math.abs(last[1] - 200) < 0.5
    && Math.abs(last[0] - 2053.76) < 1.0;
  console.log(`RECV 11: up=${up} down=${down} n=${samples.length} first=${samples[0]} last=${samples[samples.length - 1]} -> ${ok ? "PASS" : "FAIL"}`);
  ws.close();
  process.exit(ok ? 0 : 1);
});
ws.addEventListener("error", (e) => { console.log("WS ERROR", e.message || String(e)); process.exit(2); });
