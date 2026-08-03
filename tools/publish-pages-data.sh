#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Publish ONE base block to its own GitHub Pages DATA REPO — the browser-readable host (PLAN-SCALE §6f F4).
#
# WHY A THIRD PUBLISHER. The other two channels each fail one requirement:
#   * `publish-release.sh`  — serves Range, sends NO `Access-Control-Allow-Origin`, so a browser on the
#                             app's origin cannot read it. It is the download / native / offline channel.
#   * `publish-bucket.sh`   — serves Range AND CORS, and costs money and credentials (D2, R2/B2).
# GitHub Pages does both for free: measured 2026-08-01, a cross-origin ranged GET against the live site
# answers `206` with `access-control-allow-origin: *`. So a second Pages site is a CORS host we already
# have, and §6f's design gives each base block one.
#
# ⚠ THE BLOCK IS NEVER COMMITTED. GitHub hard-rejects any file over 100 MB and these are 555-794 MB. It
# reaches Pages the same way the main site's roads do: a workflow DOWNLOADS it from the routing release
# and uploads it as the Pages ARTIFACT, which has its own ~1 GB limit. That is why this script pushes a
# repo containing a workflow and a README and nothing else — the data arrives at deploy time.
#
# ⚠ AND THE SIZE CAP IS PER SITE, which is the whole reason there are four of them. `site_size_gate.sh`
# holds the main site to 950 MB; each data repo carries one block and is checked here before it is built.
#
#   tools/publish-pages-data.sh <region-id> <block-path> <data-repo> [release-tag]
#   DRY_RUN=1 tools/publish-pages-data.sh …     # print every outward action, take none
#
# Outward actions, in order, so a half-published block is never something the index can resolve into
# (§7 R6): create the repo → push the workflow → enable Pages → run it → VERIFY a cross-origin ranged
# GET returns the right bytes. Only then is the URL fit to go in `data/coverage.toml`.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
id="${1:-}"; block="${2:-}"; repo="${3:-}"; tag="${4:-data-$(date -u +v%Y-%m-%d)}"
src_repo="${RELEASE_REPO:-jjstwerff/routing}"
dry="${DRY_RUN:-0}"
[ -n "$id" ] && [ -n "$block" ] && [ -n "$repo" ] \
  || { echo "usage: publish-pages-data.sh <region-id> <block-path> <data-repo> [release-tag]"; exit 2; }
[ -f "$block" ] || { echo "FAIL: no block at $block"; exit 1; }
command -v gh >/dev/null || { echo "FAIL: gh not found"; exit 1; }

name="$(basename "$block")"
bytes="$(stat -c%s "$block")"
mb=$((bytes / 1000000))
owner="${repo%%/*}"; short="${repo##*/}"
url="https://$owner.github.io/$short"

echo "== publish $id → $repo =="
echo "   block   $name  ($mb MB)"
echo "   from    $src_repo release $tag"
echo "   serving $url/$name"
# The per-site cap, checked BEFORE anything is created: a block over it produces a repo whose deploy can
# never succeed, and the failure surfaces as a missing map rather than as a rejected upload.
if [ "$mb" -gt 950 ]; then
  echo "FAIL: $name is $mb MB — over the ~1 GB Pages per-site cap. Cut the region finer (PLAN-SCALE §6f F3)."
  exit 1
fi

run() {  # every outward action goes through here, so DRY_RUN can neutralise all of them in one place
  if [ "$dry" = "1" ]; then echo "   DRY  $*"; else "$@"; fi
}

# --- 1. the repo, and it must be PUBLIC or Pages will not serve it on a free plan -------------------
if gh repo view "$repo" >/dev/null 2>&1; then
  echo "   repo exists"
else
  run gh repo create "$repo" --public \
    --description "Base-map block $name for jjstwerff/routing — data only, served over GitHub Pages" || exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ "$dry" = "1" ]; then mkdir -p "$work/repo"; else
  git clone -q "https://github.com/$repo.git" "$work/repo" 2>/dev/null || { mkdir -p "$work/repo"; git -C "$work/repo" init -q; }
fi
mkdir -p "$work/repo/.github/workflows"

cat > "$work/repo/README.md" <<EOF
# $short

One base-map block for **[jjstwerff/routing](https://github.com/$src_repo)**, and nothing else.

\`$name\` ($mb MB) is served from GitHub Pages at

    $url/$name

The app reads it **by byte range**, a viewport at a time — a screen costs a few MB, never the file. It
lives in its own repository because the size cap that matters is per SITE: the app's own site already
carries the road network, and a country's base map does not fit beside it.

The block is **not committed** — GitHub rejects files over 100 MB. The workflow here downloads it from
the routing release and publishes it as the Pages artifact, so this repository stays a few kilobytes.

## Data

OpenStreetMap data, © OpenStreetMap contributors, licensed **ODbL 1.0**. See
[LICENSE.data](https://github.com/$src_repo/blob/main/LICENSE.data) and
[ATTRIBUTION.md](https://github.com/$src_repo/blob/main/ATTRIBUTION.md) in the routing repository.
EOF

cat > "$work/repo/.github/workflows/pages.yml" <<EOF
# Publish one base-map block to Pages. The block is NOT in this repository — it is downloaded from the
# routing release at deploy time, because GitHub rejects files over 100 MB and this one is $mb MB.
name: pages
on:
  workflow_dispatch:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: false
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - name: Fetch the block from the routing release
        run: |
          mkdir -p _site
          for f in $name $name.dschema; do
            # A missing sidecar is not fatal — a missing BLOCK is, and a truncated one is worse than
            # either, so the size is checked before it is served.
            curl -fsSL --retry 3 -o "_site/\$f" \\
              "https://github.com/$src_repo/releases/download/$tag/\$f" || {
                case "\$f" in *.dschema) echo "note: no \$f in the release";; *) echo "FAIL: \$f"; exit 1;; esac; }
          done
          got=\$(stat -c%s "_site/$name")
          [ "\$got" = "$bytes" ] || { echo "FAIL: $name is \$got bytes, expected $bytes"; exit 1; }
          echo "fetched $name (\$got bytes)"
      - uses: actions/upload-pages-artifact@v3
        with: { path: _site }
      - id: deployment
        uses: actions/deploy-pages@v4
EOF

if [ "$dry" = "1" ]; then
  echo "   DRY  would commit README.md + .github/workflows/pages.yml and push to $repo"
else
  git -C "$work/repo" add -A
  git -C "$work/repo" -c user.email=noreply@github.com -c user.name="routing publisher" \
      commit -q -m "publish $name from $src_repo $tag" || echo "   (nothing to commit)"
  git -C "$work/repo" branch -M main
  git -C "$work/repo" remote add origin "https://github.com/$repo.git" 2>/dev/null || true
  git -C "$work/repo" push -q -u origin main --force || { echo "FAIL: push"; exit 1; }
fi

# --- 2. Pages, built BY THE WORKFLOW (not from a branch, which would look for committed files) -------
run gh api -X POST "repos/$repo/pages" -f "build_type=workflow" >/dev/null 2>&1 \
  || run gh api -X PUT "repos/$repo/pages" -f "build_type=workflow" >/dev/null 2>&1 || true
run gh workflow run pages.yml --repo "$repo" >/dev/null 2>&1 || true

if [ "$dry" = "1" ]; then echo "   DRY  would wait for the deploy, then verify a cross-origin ranged GET"; exit 0; fi

echo -n "   deploying"
for _ in $(seq 60); do
  sleep 20; echo -n "."
  code="$(curl -s -o /dev/null -w '%{http_code}' -r 0-15 "$url/$name")"
  [ "$code" = "206" ] && break
done
echo

# --- 3. VERIFY, because "the workflow went green" is not "a browser can read it" --------------------
#
# ⚠ RETRY, because a green deploy is not a propagated one. Pages serves the PREVIOUS artifact for a
# short while after the run completes, so a single check right after the deploy reports the old size and
# fails a publish that is perfectly correct — measured 2026-08-03 on nl-west: "FAIL: served 555212616
# bytes, block is 555499328", and the same URL returned 555499328 two minutes later. A false FAIL on a
# 3 GB publish is worse than a slow one: it invites someone to re-run an operation that already worked.
for attempt in $(seq 1 20); do
  hdr="$(curl -s -D - -o /dev/null -r 0-15 -H 'Origin: https://jjstwerff.github.io' "$url/$name")"
  code="$(echo "$hdr" | head -1 | awk '{print $2}')"
  acao="$(echo "$hdr" | grep -ci '^access-control-allow-origin')"
  crange="$(echo "$hdr" | grep -oPi '^content-range: bytes 0-15/\K[0-9]+' | tr -d '\r')"
  [ "$code" = "206" ] && [ "$crange" = "$bytes" ] && break
  [ "$attempt" = 20 ] && break
  echo "   …serving ${crange:-?} of $bytes, waiting for the deploy to propagate ($attempt/20)"
  sleep 15
done
echo "   ranged GET → $code · ACAO $([ "$acao" -gt 0 ] && echo present || echo MISSING) · size ${crange:-?}"
[ "$code" = "206" ] || { echo "FAIL: $url/$name did not answer a ranged GET"; exit 1; }
[ "$acao" -gt 0 ]   || { echo "FAIL: no Access-Control-Allow-Origin — a browser cannot read this"; exit 1; }
[ "$crange" = "$bytes" ] || { echo "FAIL: served $crange bytes, block is $bytes"; exit 1; }
echo "PASS — $id is readable cross-origin, by range: base_url_base = $url"
