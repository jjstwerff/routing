#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# tools/build-base.sh caches every osmium pass, and the cache must be keyed on the RECIPE, not just on
# mtimes.
#
# The failure this exists for already happened once, in the sibling script: build-blocks.sh skipped a
# step whose output was newer than its input, so the day `n/barrier` was added to the filter it reused a
# way-only export and produced a "successfully regenerated" country block with ZERO barriers. build-base
# carried the identical shape until 2026-07-31 — five layer caches keyed on mtime alone, with the
# tags-filter expressions not in the key at all. A stale layer there is a base map quietly missing a
# whole class of feature: the same defect as the dirt road that was in the data and invisible on the map.
#
# osmium and loft are STUBBED here on purpose. What can silently rot is the cache DECISION, not osmium's
# filtering, and stubbing makes the decision observable in milliseconds instead of a country-sized build.
# Each stub writes its own arguments into its output, so "did this layer rebuild?" is answered by reading
# the file rather than by timing.
#
#   tools/base_recipe_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
fail=0
ok()   { printf '  \342\234\223 %s\n' "$1"; }
bad()  { printf '  FAIL: %s\n' "$1"; fail=1; }

# --- stubs -----------------------------------------------------------------------------------------
mkdir -p "$work/bin"
cat > "$work/bin/osmium" <<'STUB'
#!/usr/bin/env bash
# Record the call's own arguments as the output's content, so a rebuild is visible in the bytes — and
# make `export` COPY its input, the way the real one derives from the filtered pbf. Without that the
# filter dies at the tags-filter step and never reaches the .geojsonseq the gate reads.
sub="$1"; shift
case "$sub" in --version) echo "osmium version 0.0-stub"; exit 0 ;; esac
out=""; prev=""; in=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
for a in "$@"; do [ -f "$a" ] && { in="$a"; break; }; done
[ -n "$out" ] || exit 0
if [ "$sub" = "export" ] && [ -n "$in" ]; then cp "$in" "$out"; else printf '%s %s\n' "$sub" "$*" > "$out"; fi
STUB
cat > "$work/bin/loft" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do last="$a"; done
case " $* " in
  *store_extent*) echo "EXTENT 520000000 40000000 530000000 70000000 9 99"; exit 0 ;;
esac
printf 'stub-store\n' > "$last"      # the generator's last argument is the output store
STUB
chmod +x "$work/bin/osmium" "$work/bin/loft"
export PATH="$work/bin:$PATH" LOFT_BIN="$work/bin/loft"
export BLOCKS_WORK="$work/cache" BLOCKS_OUT="$work/out"
mkdir -p "$BLOCKS_WORK" "$BLOCKS_OUT"

# --- fixture: the inputs build-base.sh requires but does not make itself ----------------------------
printf 'stub-pbf\n' > "$BLOCKS_WORK/testland-latest.osm.pbf"
printf 'stub-roads\n' > "$BLOCKS_WORK/tl.geojsonseq"        # the streets export from build-blocks.sh
run() { "$1" tl testland "${2:-}" >"$work/log" 2>&1; }      # $1 = script under test, $2 = bbox

echo "== base-map caches are keyed on their recipe, not on mtimes =="

# --- 1. non-vacuity: the cache has to actually work, or "it rebuilt" proves nothing -----------------
run "$here/tools/build-base.sh" || { bad "first run failed"; sed 's/^/      /' "$work/log"; exit 1; }
[ -s "$BLOCKS_WORK/tl.pois.geojsonseq" ] && ok "first run built the layers" || bad "no pois export after the first run"
first="$(cat "$BLOCKS_WORK/tl.pois.geojsonseq")"
run "$here/tools/build-base.sh"
grep -q "pois: up to date" "$work/log" \
  && ok "an unchanged rerun reuses the cache (so a rebuild below is a real signal)" \
  || bad "the cache never hits — this gate would pass vacuously"

# --- 2. THE FIX: a changed layer filter must invalidate that layer ----------------------------------
# Editing a filter is exactly the scenario, so the gate edits one, in a copy of the script.
sed 's|^layer pois .*|layer pois      n/natural n/amenity \|\| exit 1|' \
  "$here/tools/build-base.sh" > "$work/edited.sh"
chmod +x "$work/edited.sh"
cmp -s "$here/tools/build-base.sh" "$work/edited.sh" && bad "the sed did not change the pois filter — gate is broken"
run "$work/edited.sh"
after="$(cat "$BLOCKS_WORK/tl.pois.geojsonseq")"
if grep -q "recipe changed" "$work/log" && [ "$first" != "$after" ]; then
  ok "a changed pois filter rebuilt that layer (cache discarded, new filter in the export)"
else
  bad "a changed pois filter was IGNORED — the stale export survived (this is the bug)"
  sed 's/^/      /' "$work/log" | head -8
fi
# and the layers that did NOT change must still be reused, or the key is too coarse to be useful
grep -q "areas: up to date" "$work/log" && ok "an untouched layer is still cached (the key is per layer)" \
  || bad "changing one filter invalidated every layer"

# --- 3. the same for the bbox clip, which takes its recipe straight from argv -----------------------
run "$here/tools/build-base.sh" "6.7,52.1,7.0,52.3"
clip1="$(cat "$BLOCKS_WORK/tl.clip.osm.pbf" 2>/dev/null)"
run "$here/tools/build-base.sh" "6.7,52.1,7.0,52.4"          # a DIFFERENT box
clip2="$(cat "$BLOCKS_WORK/tl.clip.osm.pbf" 2>/dev/null)"
[ -n "$clip1" ] && [ "$clip1" != "$clip2" ] \
  && ok "a different bbox re-clips instead of reusing the old extract" \
  || bad "a changed bbox reused the previous clip"

# --- 4. a rebuild that DIES must not leave a stamp claiming the output --------------------------- -
printf '#!/usr/bin/env bash\nexit 3\n' > "$work/bin/osmium"; chmod +x "$work/bin/osmium"
rm -f "$BLOCKS_WORK/tl.pois.geojsonseq" "$BLOCKS_WORK/tl.pois.geojsonseq.recipe"
run "$here/tools/build-base.sh"
[ -f "$BLOCKS_WORK/tl.pois.geojsonseq.recipe" ] \
  && bad "a failed rebuild stamped a recipe for an export that was never written" \
  || ok "a failed rebuild leaves no recipe stamp (the next run retries)"

[ "$fail" -eq 0 ] || { echo "FAIL — a base-map cache can serve output built by a different recipe"; exit 1; }
echo "PASS — every base-map cache is invalidated by its own recipe"
