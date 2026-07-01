// Node WebSocket round-trip check for the routing server (PLAN step 4).
// Connect, send points (msg 1), expect the length (msg 2) within a few mm of the known haversine.
// Usage: node tools/ws_roundtrip.mjs [ws://host:port/ws]
const url = process.argv[2] || "ws://127.0.0.1:18080/ws";
const EXPECT = 1000.7557221018342; // 0.009deg-lat segment — matches geo.js + routing_kernel
const ws = new WebSocket(url);
let got = false;
const timer = setTimeout(() => { if (!got) { console.log("TIMEOUT (no reply in 10s)"); process.exit(3); } }, 10000);

ws.addEventListener("open", () => ws.send("1:52.0,5.0;52.009,5.0"));
ws.addEventListener("message", (e) => {
  got = true; clearTimeout(timer);
  const raw = e.data.toString();
  const i = raw.indexOf(":");
  const id = raw.slice(0, i), val = parseFloat(raw.slice(i + 1));
  const ok = id === "2" && Math.abs(val - EXPECT) < 0.01;
  console.log(`RECV ${JSON.stringify(raw)} -> ${ok ? "PASS" : "FAIL"} (id=${id}, val=${val}, expect~${EXPECT})`);
  ws.close();
  process.exit(ok ? 0 : 1);
});
ws.addEventListener("error", (e) => { console.log("WS ERROR", e.message || String(e)); process.exit(2); });
