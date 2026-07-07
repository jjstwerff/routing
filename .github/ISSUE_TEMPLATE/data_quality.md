---
name: Data quality
about: A route/area matches wrongly, or a tile block looks off
title: ""
labels: data-quality
assignees: ""
---

**Area / route**
Where (coordinates or place), and the sketch points if relevant.

**What's wrong with the match**
e.g. took a bigger street where a nearby path exists; missed a curving trail; a gap/bridge; wrong
surface. (See `PLAN-MATCH` §7 — the "wanted route" is about suitability, not just length.)

**Profile**
walking_paved / cycling_road / … (which activity sub-mode).

**Is it the data or the matcher?**
- OpenStreetMap data itself wrong in that area? (Consider fixing it upstream at openstreetmap.org.)
- Or the matcher choosing badly over correct data?

**Dataset**
Which block/version (e.g. `soverijssel.tiles`), or Overpass (server mode).
