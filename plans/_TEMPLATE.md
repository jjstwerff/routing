<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Plan template

**Kind:** guide · **Status:** current · **Last verified:** 2026-08-03 · **Owns:** the skeleton every new plan copies

Copy this file to `plans/<N>-<slug>/README.md`, where **`<N>` is the `jjstwerff/routing` issue number**
— claimed *before* the directory exists, never derived from the local tree. Delete the guidance blocks
(marked *(delete)*) as you fill it in. Conventions and the lightest-workflow table:
[`README.md`](README.md).

**Before you copy — is this actually a plan?** If it fits in one `## Open work` row in the reference doc
that owns the area, it isn't. Add the row instead. If the plan needs no document space beyond its issue
body, leave it in the issue and skip the directory.

---

# `<N>` — `<Plan title>`

**Kind:** plan · **Status:** current · **Last verified:** `<YYYY-MM-DD>` · **Owns:** `<issue #N — one line>`

**Issue:** [`jjstwerff/routing#<N>`](https://github.com/jjstwerff/routing/issues/<N>) ·
**Value:** `<S|R|G|F|U|C|Q|N>` · **Effort:** `<XS|S|M|MH|H|VH>`

*(delete)* The header line above is **required and gated** — `tools/docs_gate.sh` fails without it.
`Status` is `current`, `stale — unverified since <date>` or `superseded by <path>`; `Last verified`
means someone re-checked the claims, not that the file was edited. See `docs/doc-structure-design.md`
§4. A plan README is also budgeted at **300 lines** (rule 5): past that, reference content is leaking
in — move it to the doc that owns it.

## Status (REQUIRED)

*(delete)* The **single source of truth** for what is shipped / open / deferred / blocked. The issue
carries the lifecycle label; the per-phase truth lives here, so there is no second copy to drift. One
paragraph: the state of the world today and what this plan changes.

## Goal (REQUIRED)

*(delete)* One sentence — what ships when this plan is complete. No strategy or advertising language.

## Anchors (REQUIRED)

*(delete)* The reference docs this plan implements or extends, and the source files it touches. A plan
never restates its anchors' content — it links. ⚠ **Re-measure a doc's premise before building on it**
(`CLAUDE.md`): a spec that was correct when written goes stale when a different commit removes its
justification. State which premises you re-checked and what moved.

## Data cost (REQUIRED when the block changes)

*(delete)* Does this change the store schema, and what must be regenerated? A field added to a stored
struct makes older blocks read **garbage, not empty** (loft#700), so the answer is never "nothing" if
the layout moves. State: schema change y/n · which blocks regenerate · which copiers
(`split_block`, `trim_base`, `build_overview`, `merge_base`) must carry the new field · what conservation
count proves none was dropped. One line if there is no data cost — silence reads as "free", not "N/A".

## Invariant gate (REQUIRED for exact-invariant work)

*(delete)* Geometry, tiling, serialisation, round-trips and file formats are **exact invariants, not
open spaces**. State per phase: the **concrete expected result** (the exact target output for one
specific input), the **invariant** it pins (a cut → *conservation: parts sum to the whole*; a matcher
change → *the route is byte-identical*), and the **negative control** — the input that must be
*refused*, not silently accepted.

Say so in one line if a phase has no exact-invariant surface. Silence reads as "gate done", not "N/A".

## Phases (REQUIRED if multi-phase)

*(delete)* One row per phase, each **one commit, one observable** — the house style. **Verify** names
the gate: a script in `tools/`, a unit test, a CDP browser check, a conservation count. "It looks right"
is not a gate; a probe outside a gate is a comment.

| Phase | Effort | Verify | Status |
|---|---|---|---|
| **A** — short title | S | `tools/<x>_gate.sh` | Open |
| **B** — short title | M | conservation count in / out | Blocked on A |

## Open questions

*(delete)* Numbered, each with a resolution path (which phase decides it, or which probe answers it).
Delete the section if there are none.
