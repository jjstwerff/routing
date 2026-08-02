#!/usr/bin/env python3
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Add the middle-zoom block to a LOCAL gate index, pointing at this origin (PLAN-SCALE §6i O3b).
#
# nl-mid is hosted on its own Pages data repo, so `SITE_LOCAL_ONLY` drops it and a local gate would have
# no data for the z12-13 band — the band would go untested while the gate stayed green, which is the
# shape of failure F5 is named after. The block itself is identical; only the URL differs.
import json, sys

site, full = sys.argv[1], sys.argv[2]
d = json.load(open(site))
f = json.load(open(full))
mid = next((b for b in f.get("blocks", []) if b["id"] == "nl-mid"), None)
if mid is None:
    sys.exit(0)                                   # no middle level in this dataset: nothing to stage
if any(b["id"] == "nl-mid" for b in d.get("blocks", [])):
    sys.exit(0)
mid = json.loads(json.dumps(mid))
mid["base"]["url"] = "stores/nl-mid.base.store"   # same block, this origin
d["blocks"].append(mid)
json.dump(d, open(site, "w"))
print("  staged nl-mid locally for the z12-13 band")
