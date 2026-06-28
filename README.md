# routing

A **phone-first** map tool for quickly sketching a route (running / cycling / walking / driving),
seeing the length **instantly**, having the rough sketch **matched onto real paths** suited to the
activity, and **exporting GPX** with an accurate length.

> **North-star:** easy to pick up, a precision knife in the hands of an expert. Low floor (tap a few
> points, zero setup, forgiving imprecise taps, good activity defaults), high ceiling (the same tiny
> primitive set — points, zoom-as-precision, sub-mode, live length — gives exact, fast control).

## How it works (in one breath)

- **JS (vanilla + [Leaflet](https://leafletjs.com/)) owns the pixels:** the map (OSM base +
  Waymarkedtrails overlay), the draggable rough points, the instant rough length, and drawing the
  detailed route.
- **[loft](https://github.com/loft-lang/loft) owns the routes:** a compact **AOT WebAssembly**
  kernel (no parser shipped to the browser) that downloads its own road-pattern data, **map-matches**
  the drawn line onto real paths, computes accurate **geodesic** length, and does GPX import/export.
- The match is **faithful, not scenic** — it cleans your sketch onto the nearest sensible ways in a
  **tight corridor**; it never detours for a prettier road. Correct a wrong match by **moving the
  points** (zoom in for precision), never by editing the matched line.
- **Activity × sub-mode profiles** (running Fast/Trail, cycling Road/Gravel/MTB, walking
  Paved/Trail, driving Fastest/Avoid-motorways) make the *first* match good by default.

## Deployment — hybrid

- **Standalone:** pure static files + the wasm kernel. No server, routes in the browser, shared via
  GPX. What anyone can just open.
- **Server-backed:** a loft server (built on loft's `lib/server` + `lib/world` + `lib/engine_host`)
  serves the client, syncs edits over WebSocket, and persists the route store to disk (direct
  backup). The standalone build is a strict subset.

## Status

Design phase. The full design lives in **[DESIGN.md](DESIGN.md)**.

This project is a sibling consumer of the loft language (expected at `../loft`).
