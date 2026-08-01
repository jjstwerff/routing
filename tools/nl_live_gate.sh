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
dtport="${DTPORT:-9243}"
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
"$here/tools/build_index.sh" "$site/coverage.json" >/dev/null \
  || { echo "  FAIL: could not build the coverage index"; exit 1; }

srv=""; chr=""
cleanup() { kill "$chr" "$srv" 2>/dev/null; }
trap cleanup EXIT

echo "== N3: a visitor outside Enschede, on the country block =="
rm -rf "$here/scratch/chromium-$dtport"; mkdir -p "$here/scratch"
# Range, because a 222 MB block is read paged — python's own http.server answers every page request with
# the whole file, and the gate would be grading something else entirely.
python3 "$here/tools/range_server.py" "$httpport" "$site" /dev/null >/dev/null 2>&1 &
srv=$!
"$chromium" --headless=new --disable-gpu --no-sandbox --window-size=1000,700 \
  --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port="$dtport" about:blank >/dev/null 2>&1 &
chr=$!
sleep 4

node "$here/browser/cdp_nl_live.mjs" "127.0.0.1:$dtport" "http://127.0.0.1:$httpport/index.html"
