// Node WebSocket check for the elevation profile (PLAN step 15 + the map-zoom tie-in).
// Against the synthetic step tile (see make_terrarium_tile.loft, z13): the zoom-prefixed and the
// bare legacy request both profile it (up≈100/down≈0, west 100 m → east 200 m), and a z15 request
// proves the client zoom is honored — no z15 tiles are cached, so the profile comes back empty.
// Usage: node tools/ws_elevation.mjs [ws://host:port/ws]
const url = process.argv[2] || "ws://127.0.0.1:18080/ws";
const ws = new WebSocket(url);

const queue = [];
ws.addEventListener("message", (e) => { const w = queue.shift(); if (w) w(e.data.toString()); });
ws.addEventListener("error", () => { console.log("WS ERROR"); process.exit(2); });
const send = (msg, timeoutMs = 30000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("timeout: " + msg.slice(0, 24))), timeoutMs);
  queue.push((raw) => { clearTimeout(t); res(raw); });
  ws.send(msg);
});
await new Promise((res) => ws.addEventListener("open", res));

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) fail = 1;
};
const pts = "52.0,4.97;52.0,5.0";
const parseReply = (raw) => {
  const [up, down, prof] = raw.slice(raw.indexOf(":") + 1).split("|");
  const samples = prof ? prof.split(";").filter(Boolean).map((s) => s.split(",").map(Number)) : [];
  return { up: parseFloat(up), down: parseFloat(down), samples };
};
const goodProfile = (r) =>
  Math.abs(r.up - 100) < 0.5 && Math.abs(r.down) < 0.5 && r.samples.length >= 20
  && Math.abs(r.samples[0][1] - 100) < 0.5
  && Math.abs(r.samples[r.samples.length - 1][1] - 200) < 0.5
  && Math.abs(r.samples[r.samples.length - 1][0] - 2060.34) < 1.0;

let r = parseReply(await send(`10:13|${pts}`));
check("zoom-prefixed request profiles the z13 tile", goodProfile(r),
      `up=${r.up} down=${r.down} n=${r.samples.length}`);

r = parseReply(await send(`10:${pts}`));
check("bare legacy request still works", goodProfile(r), `n=${r.samples.length}`);

// A z15 request must NOT reuse the z13 fixture: offline it has no tiles (empty profile); online
// it live-fetches real z15 terrain (a flat polder) — either way it can't reproduce the synthetic
// step signature.
r = parseReply(await send(`10:15|${pts}`, 120000));
check("z15 request is honored (not the z13 fixture profile)", !goodProfile(r),
      `up=${r.up} n=${r.samples.length}`);

console.log(fail ? "FAILURES" : "ALL PASS — elevation follows the map zoom; legacy form intact.");
ws.close();
process.exit(fail);
