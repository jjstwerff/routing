<!--
Copyright (c) 2026 Jurjen Stellingwerff
SPDX-License-Identifier: LGPL-3.0-or-later
-->

# Debugging a client through the server, over WebSockets

**Kind:** reference · **Status:** current · **Last verified:** 2026-07-30 · **Owns:** the live-debug WebSocket channel between the browser and a loft debugger

The server mode (`server/server.loft` + `ws.js`) is one loft process speaking `"<opcode>:<payload>"` frames
to browser clients over `/ws`. When something misbehaves there, the expensive mistake is starting in the
browser: the client is the *least* observable end, and half the symptoms ("nothing happened") are the
server never replying. **Work from the protocol inwards.**

> ⚠ **This is about SERVER mode only.** The standalone app (`browser/store-app.*`, `PLAN-BUILD`) has no
> server and no WebSocket — matches run in wasm in the page. If you are debugging *that*, you want
> `tools/map_render_gate.sh` and `PLAN-PERF`'s `__perfHooks`, not this document.

---

## 1. The 60-second loop

```bash
fuser -k 18080/tcp 2>/dev/null            # the port is the #1 source of confusing failures
LOFT_BIN="$(command -v loft)" make run    # server on http://localhost:18080  (http + /ws)
                                          # …or: loft --native server/server.loft --lib lib
node tools/ws_poke.mjs '1:52.2,6.85;52.22,6.88'   # cheapest liveness check: expect `2:3026.19…`
node tools/ws_poke.mjs '4:cycling_road|52.2,6.85;52.22,6.88'    # ask for a match, print the reply
```

`tools/ws_poke.mjs` is the tool to reach for first: it sends exactly the frames you name and prints every
frame that comes back, timestamped, with no browser and no assertions in between. **If `ws_poke` gets the
right answer, the bug is in the client**; if it does not, you have halved the problem without opening
devtools.

```bash
node tools/ws_poke.mjs --listen                     # send nothing, watch for BROADCASTS from other clients
WAIT=8000 node tools/ws_poke.mjs '10:14|52.2,6.85;52.22,6.88'  # slow handler? extend the listen window
node tools/ws_poke.mjs ws://127.0.0.1:18080/ws '14:' '16:Morning Loop'   # several frames, in order
```

**What a working session looks like** (verified 2026-07-30 against the installed loft):

```
   14ms  →  1:52.2,6.85;52.22,6.88
   16ms  ←  2:3026.1916044244463
  587ms  ←  21:Schuttersveld · 3.0 km · Road ride        # from a 20: propose-name frame
```

⚠ **A `4:` match needs DATA.** If the server logs `no tile block (soverijssel.tiles) — using Overpass`,
every match is a network call, so a sandbox with no egress makes `4:` look broken when the transport is
fine. `1:` and `20:` work offline — use those to test the socket itself.

⚠ **`LOFT_BIN` matters.** The `tools/*_test.sh` harnesses default to `../loft/target/release/loft` — the
sibling agent's *live* build tree, which `CLAUDE.md` says not to rely on. Pass
`LOFT_BIN="$(command -v loft)"` to run against the installed binary, which is what the `Makefile` does.

---

## 2. The protocol, so a trace is readable

Frames are text: `"<opcode>:<payload>"`, payload fields separated by `|`, point lists as
`lat,lon;lat,lon`. **The reply opcode is the request + 1** (`1→2`, `4→5`, `16→17`…), with two exceptions: `14:` and `18:`
both answer with the route list `13:`. The dispatch is one `if` chain at `server/server.loft:675`.

| send | reply | what it is |
|---|---|---|
| `1:<points>` | `2:<metres>` | sketch length, no matching — the cheapest liveness check |
| `2:<points>` | `3:<way count>` (`3:err`) | Overpass corridor probe — **needs network** |
| `4:<profile>\|<points>` | `5:<matched_m>\|<polyline>` | **the match** — the one you usually care about |
| `6:<name>\|<profile>\|<points>` | `7:<gpx>` | export GPX |
| `8:<raw points>` | `9:<retrace_m>\|<cleaned>` | clean an imported track |
| `10:<zoom>\|<points>` | `11:<up>\|<down>\|<d,e;…>` | elevation profile of the detailed route |
| `12:<name>\|<profile>\|<points>` | `13:<names>` → **all clients** | save / overwrite |
| `14:` | `13:<names>` | list routes |
| `16:<name>` | `17:<name>\|<profile>\|<points>\|<hist>` (bare `17:` = unknown) | open — **and subscribe** |
| `18:<name>` | `13:<names>` → **all clients** | delete |
| `20:<profile>\|<points>` | `21:<proposed name>` | propose a name (bare `21:` = degenerate sketch) |
| `24:<profile>\|<points>\|<hist>` | `25:` | autosave without re-matching |
| `26:<city>` | `27:<lat>\|<lon>` (bare `27:` = lookup failed) | forward-geocode |
| — | `23:<name>\|<body>` | **broadcast**: another subscriber's accepted edit |

**Two semantics that explain most "wrong" traces** (`server.loft` ~431–470):

- **`13:` (the route list) is a plain broadcast — the sender gets it too.** Verified: `12:save` then
  `14:list` on one connection returns **two** `13:` frames, the first from the save's broadcast. Only `23:`
  is echo-free.
- **Opening or saving a shared (non-`_`) route SUBSCRIBES that connection to it.** Later accepted edits by
  any subscriber write through to the named route and broadcast `23:` to *the others*.
- **The broadcast is echo-free**: the editor does **not** receive its own `23:`. A test that waits for one
  on the sending connection hangs forever, and that is the harness being wrong, not the server.

---

## 3. The server's own view

Everything the server prints goes to stdout, so run it with a log you can `tail`:

```bash
LOFT_TIMEOUT=0 loft --native server/server.loft --lib lib >scratch/srv.log 2>&1 &
tail -f scratch/srv.log
```

- **`LOFT_TIMEOUT=0`** — otherwise loft's watchdog kills a long-lived server mid-session (the harnesses all
  set it).
- **A handler that raises prints there and nowhere else.** *No reply on the socket + a line in the log* is
  the signature; the client just sees silence.
- **`loft --generate-log-config`** writes a documented config you can point at with `--log-conf` when you
  want loft's own levels rather than the server's `println`s.
- **`--dev-soft-halt`** demotes runtime raises to log-and-continue, so one run surfaces *every* fault site
  instead of stopping at the first — useful when a whole class of frames is failing.

Add a temporary trace inside a handler with `println` (it is a native process, so this is free):

```loft
println("ws {cid} <- {msg}");          // at the dispatch site: every inbound frame, per connection
```

---

## 4. The client's view

`ws.js` connects to `` `${proto}://${location.host || "localhost:18080"}/ws` `` and dispatches on the
opcode prefix. In the browser: **DevTools → Network → the `/ws` request → Messages** shows every frame in
both directions, which is the ground truth for "did the client actually send it".

Three client-side traps worth checking before blaming the server:

1. **The client reconnects, and a reconnect is not a resubscribe.** A dropped socket loses the
   subscription; the client must re-`16:` to be on a route again. A "broadcast stopped arriving" report is
   usually this.
2. **Coalescing.** The client does not send a frame per interaction (a drag emits ~33 moves/second). If a
   frame you expect never appears on the wire, look for the coalescer before the server.
3. **`location.host` is empty on `file://`** — the fallback is `localhost:18080`, so an app opened as a
   file talks to a *different* server than the one you may have started on another port.

---

## 5. When you need two clients (the interesting bugs)

Anything about subscriptions, broadcast or late-join needs more than one connection, and both harnesses
already exist — read them before writing a third:

| harness | tier | what it drives |
|---|---|---|
| **`tools/sync_test.sh`** → `tools/ws_sync.mjs` | protocol | three node clients: subscribe via open/save, echo-free broadcast, **late-joiner replay**, unsubscribe-by-switching. Starts and stops the server itself |
| **`tools/client_sync_test.sh`** | real client | two headless Chromium tabs over CDP: an edit in tab 1 must appear in tab 2 **without tab 2 sending anything** |
| `tools/client_routes_test.sh`, `tools/client_elev_test.sh` | real client | the routes list and the elevation profile, same CDP shape |
| `tools/server_test.sh` | protocol | the offline gates (named store round-trip, autosave) |

Debugging recipe with two connections, no browser:

```bash
node tools/ws_poke.mjs --listen &                 # connection A: subscribe then watch
node tools/ws_poke.mjs '16:Morning Loop'          # (A must send 16: itself to be subscribed)
node tools/ws_poke.mjs '16:Morning Loop' '4:cycling_road|52.0,4.97;52.0,5.01'   # B edits
                                                  # → A should print a 23: frame, B must NOT
```

⚠ **These harnesses write real files.** `client_sync_test.sh` overwrites your `_working` sketch and
`routes/*.route`; `sync_test.sh` creates `test_*` routes. Do not debug against routes you care about.

---

## 6. Symptom → first place to look

| symptom | most likely cause |
|---|---|
| connect throws / `ERROR` immediately | server not up, or the port is held — `fuser -k 18080/tcp`, then check `scratch/srv.log` |
| frame sent, **no reply at all** | unhandled opcode, unparseable payload, or the handler raised — the server log is the only witness |
| `5:` reply with an empty polyline | the match found nothing (corridor/coverage), not a transport problem — try the same points through `tools/match_parity.sh` |
| reply arrives but the client ignores it | opcode prefix mismatch in `ws.js`'s dispatch, or the client moved on (see coalescing) |
| broadcast never arrives at the other client | the other connection is not subscribed (it must `16:`/`12:` itself), or it is the *editing* connection (echo-free by design) |
| broadcast stopped after a while | the socket dropped and reconnected — a reconnect does not resubscribe |
| works via `ws_poke`, fails in the browser | it is the client: DevTools → Network → `/ws` → Messages |
| works in the browser, fails in a harness | the harness's `LOFT_BIN` default points at the sibling dev tree — pass the installed loft |
