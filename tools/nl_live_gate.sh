#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-SCALE N3 — the step that makes the tool useful to someone outside Enschede, gated.
#
# The claim N3 makes is narrow and easy to believe without checking: the NL ROADS (497 MB for both
# halves) ship beside the app on Pages, the NL BASE MAP (2.87 GB) does not, and a visitor anywhere in the
# country therefore gets routing on a plain background. Every other browser gate opens on Enschede, where
# a small committed block supplies both — so all of them can pass while this is entirely broken.
#
# It has already been broken twice in one sitting, both times invisibly:
#   * `build-site.mjs` copied only blocks under 64 MB, so the index named nl-east with a relative URL and
#     the site did not serve it. Matching outside Enschede returned no route, and no gate noticed.
#   * `roadsUrlsFor` picked the smallest block CONTAINING the box. nl-west and nl-east have overlapping
#     bboxes (ways overhang the cell cut), so a box near the 5.40°E seam named one half and silently lost
#     the roads on the other.
#
#   tools/nl_live_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
profile="$here/scratch/chromium-nl_live"
httpport="${HTTPPORT:-8143}"
site="$here/_site"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
# The country blocks are generated output, not source (gitignored, ~500 MB). Without them there is no NL
# to be live, so this SKIPs rather than fails — a fresh clone has not built them.
[ -f "$site/stores/nl-west.roads.store" ] || {
  echo "SKIP: no nl-west block in the site (build: tools/build-blocks.sh + tools/build_index.sh + node browser/build-site.mjs)"
  exit 2; }
# Self-sufficient: `build-site.mjs` REMOVES _site and rebuilds it, so the index may be missing whenever
# the site was rebuilt since the last index build. A gate that needs another gate to have just run is a
# gate that fails for the wrong reason.
# Written into `$site`, not just `browser/` — the page reads the one in the site, and other gates
# (cors_host_gate) legitimately rewrite it for their own run.
# ⚠ THE BASE BLOCKS MUST BE SERVED FROM THIS GATE'S OWN ORIGIN, and inheriting the published URLs is a
# configuration that exists NOWHERE in production. In production the app is `jjstwerff.github.io/routing`
# and its base data `jjstwerff.github.io/routing-data-nl-*` — different PATHS on ONE origin, so no CORS is
# involved. This gate serves the app from 127.0.0.1, so those absolute URLs make the read genuinely
# cross-origin, and it then fails on GitHub's CORS policy rather than on anything the app does: Pages
# sends `access-control-allow-origin: *` but NOT `access-control-expose-headers: content-range`, and
# Content-Range is not CORS-safelisted — so the paged reader cannot learn the store's size and gives up
# after two `bytes=0-0` probes, drawing nothing.
#
# Measured 2026-08-03, three ways: the same block served locally draws 252 450 features in ~5 s; served
# from Pages it makes 3 requests and stops; served from Pages with `--disable-web-security` it draws the
# identical 252 450. `cors_host_gate` owns the cross-origin question and states the two headers a real
# CORS host must send. This gate is about the APP, so it serves the base the way production does.
work_mf="$(mktemp -d)"; trap 'rm -rf "$work_mf"' EXIT
python3 - "$here" "$work_mf/coverage.toml" <<'PY'
import pathlib, sys
here, out = sys.argv[1], sys.argv[2]
src = pathlib.Path(here, "data/coverage.toml").read_text().splitlines(keepends=True)
regions, cur = [], []
for line in src:
    if line.startswith("[[region]]") and cur:
        regions.append(cur); cur = []
    cur.append(line)
regions.append(cur)
kept = 0
res = []
for r in regions:
    rid = next((l.split('"')[1] for l in r if l.strip().startswith("id")), "")
    local = pathlib.Path(here, "blocks", f"{rid}.base.store").exists()
    # Drop the remote base host ONLY where the block is present locally; otherwise leave the URL alone,
    # so a region we cannot serve keeps failing honestly instead of 404ing against our own origin.
    if local:
        kept += 1
        r = [l for l in r if not l.strip().startswith(("base_url_base", "base_cors"))]
    res.extend(r)
pathlib.Path(out).write_text("".join(res))
print(f"  serving {kept} base block(s) from this gate's own origin, as production does (one origin, different paths)")
PY
for b in "$here"/blocks/*.base.store; do
  [ -e "$b" ] || continue
  ln -sfn "$b" "$site/stores/$(basename "$b")"
  [ -f "$b.dschema" ] && ln -sfn "$b.dschema" "$site/stores/$(basename "$b").dschema"
done
COVERAGE_MANIFEST="$work_mf/coverage.toml" "$here/tools/build_index.sh" "$site/coverage.json" >/dev/null \
  || { echo "  FAIL: could not build the coverage index"; exit 1; }

srv=""
cleanup() { [ -n "$srv" ] && kill "$srv" 2>/dev/null; return 0; }
trap cleanup EXIT

echo "== N3: a visitor outside Enschede, on the country block =="
rm -rf "$profile"; mkdir -p "$here/scratch"
# Range, because a 222 MB block is read paged — python's own http.server answers every page request with
# the whole file, and the gate would be grading something else entirely.
python3 "$here/tools/range_server.py" "$httpport" "$site" /dev/null >/dev/null 2>&1 &
srv=$!
# ⚠ THIS SCRIPT NO LONGER LAUNCHES A BROWSER, and that is the point. It used to start Chromium on a
# debugging PORT and take it down from `trap cleanup EXIT` — correct for every way this script ends, and
# useless for the way it actually dies (a timeout or an interrupted turn kills the shell, no trap runs,
# and a detached browser owned by nobody runs for days). The driver now owns it over a CDP pipe, so the
# browser cannot outlive `node` on any OS and there is nothing here to clean up. See browser/cdp_transport.mjs.
CHROMIUM_BIN="$chromium" node "$here/browser/cdp_nl_live.mjs" "$profile" "http://127.0.0.1:$httpport/index.html"
