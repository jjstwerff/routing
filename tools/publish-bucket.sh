#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Publish the generated blocks to an S3-compatible bucket — the host the BROWSER can read (PLAN-SCALE D2).
#
# The GitHub release (tools/publish-release.sh) is the download/native/offline channel; it cannot serve the
# browser, because release assets send no CORS header. A bucket can, and this is the same §7 R6 shape:
# upload → verify every object answers a 206 with the size uploaded AND the CORS headers a browser needs →
# only then publish the index that names them.
#
# THE HOST REQUIREMENTS, and every one of them is something `tools/cors_host_gate.sh` will catch:
#   1. `Range` honoured with a real 206 + Content-Range        (a release asset passes this; Pages does too)
#   2. `Access-Control-Allow-Origin` for the app's origin       (release assets fail this)
#   3. an OPTIONS **preflight** that allows the `Range` REQUEST header — `Range` is not CORS-safelisted, so
#      the browser asks first, and a host that answers only GET is indistinguishable from one with no CORS
#   4. `Content-Range` in Access-Control-Expose-Headers, or the reader cannot learn the file's size
# `data/bucket-cors.json` is that policy; apply it to the bucket before the first upload.
#
#   RCLONE_REMOTE=r2:routing-data PUBLIC_BASE=https://data.example.org tools/publish-bucket.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
blocks="${BLOCKS_OUT:-$here/blocks}"
remote="${RCLONE_REMOTE:-}"
public="${PUBLIC_BASE:-}"
[ -n "$remote" ] && [ -n "$public" ] || {
  cat <<USAGE
usage: RCLONE_REMOTE=<remote:bucket> PUBLIC_BASE=<https://public-base> tools/publish-bucket.sh

  Needs an S3-compatible bucket (Cloudflare R2, Backblaze B2, …) and rclone configured for it. Apply
  data/bucket-cors.json to the bucket first:

    rclone config                             # once, to add the remote
    aws s3api put-bucket-cors --bucket <b> --cors-configuration file://data/bucket-cors.json \\
        --endpoint-url <endpoint>             # or the provider's dashboard

  Then re-run this. tools/cors_host_gate.sh is the acceptance test the result must pass.
USAGE
  exit 2; }
command -v rclone >/dev/null || { echo "FAIL: rclone not installed"; exit 1; }

echo "== upload =="
rclone copy --progress "$blocks" "$remote" --exclude "coverage.json" || { echo "FAIL: upload"; exit 1; }

echo "== verify every object: 206, size, and the CORS headers a browser needs =="
fail=0
for f in "$blocks"/*.store "$blocks"/*.dschema; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"; url="$public/$name"; local_sz="$(stat -c%s "$f")"
  hdr="$(curl -sIL -H "Origin: https://jjstwerff.github.io" -H 'Range: bytes=0-99' "$url" 2>/dev/null)"
  cr="$(echo "$hdr" | grep -iE '^content-range' | tail -1 | grep -oP '/\K[0-9]+' || true)"
  acao="$(echo "$hdr" | grep -ci 'access-control-allow-origin' || true)"
  expose="$(echo "$hdr" | grep -i 'access-control-expose-headers' | grep -ci 'content-range' || true)"
  pre="$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS -H "Origin: https://jjstwerff.github.io" \
         -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: range' "$url")"
  if [ "${cr:-0}" != "$local_sz" ]; then echo "  FAIL $name — Range gave ${cr:-no 206}, expected $local_sz"; fail=1
  elif [ "$acao" -lt 1 ]; then echo "  FAIL $name — no Access-Control-Allow-Origin"; fail=1
  elif [ "$expose" -lt 1 ]; then echo "  FAIL $name — Content-Range not exposed; the reader cannot size the file"; fail=1
  elif [ "$pre" != "200" ] && [ "$pre" != "204" ]; then echo "  FAIL $name — preflight returned $pre; Range must be an allowed request header"; fail=1
  else printf "  ok   %-40s 206 · CORS · preflight %s\n" "$name" "$pre"; fi
done
[ $fail -eq 0 ] || { echo "FAIL: not publishing an index over objects a browser cannot read"; exit 1; }

echo "== index (last, as always) =="
RELEASE_INDEX=1 RELEASE_BASE="$public" "$here/tools/build_index.sh" "$blocks/coverage.json" || exit 1
rclone copy "$blocks/coverage.json" "$remote" || exit 1
echo "PASS — published to $public, every object browser-readable, index uploaded last"
echo "  now run: tools/cors_host_gate.sh   (drives the real app against it)"
