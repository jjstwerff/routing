#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# A killed gate must not leave a browser behind. The check itself is in node so it runs the same on
# Linux, macOS and Windows — see browser/leak_gate.mjs for what it asserts and why it refuses to count
# processes to do it.
#
#   tools/browser_leak_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
CHROMIUM_BIN="$chromium" exec node "$here/browser/leak_gate.mjs"
