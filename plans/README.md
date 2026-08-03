<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# plans/ — routing's plan structure

routing organises multi-phase work the way **loft**, **crawler** and **moros** do, so one convention
spans every repo. This file is the **binding** — the conventions and where routing differs.

- A **reference doc** (`DESIGN.md`, `docs/ARCHITECTURE.md`, `PLAN-SCALE.md`, `PLAN-PERF.md`, …)
  describes **how the thing works and what it cost** — the durable truth, updated in place as the code
  changes.
- A **plan** describes **a change we intend to make** — phases, ordering, verification. It is
  temporary: when a phase ships, its reference content **moves out** to the doc that owns it, and the
  plan keeps only the closure record.

If you cannot say what *changes* when the plan is done, it is a doc, not a plan.

⚠ **The 16 root-level `PLAN-*.md` files predate this and are NOT plans in this sense.** They are
reference docs that grew step ladders inside them — `PLAN-SCALE.md` is 2 147 lines of measurements,
phases and closure records in one file, against the 100–300 line budget below. They stay where they
are; **migrate opportunistically, never in a sweep**, and author new multi-phase work here. Most of
them will end up as reference docs with an `## Open work` section rather than as plans, because that
is what they actually are.

## Pick the lightest workflow that fits

| Work shape | Path |
|---|---|
| **Bug fix** (one root cause, one commit) | Fix + a gate that would have caught it + commit. No plan, no issue. |
| **Upstream (loft) defect** | File it on `loft-lang/loft` with `hit-by:routing`. **Never a routing plan.** |
| **Data regeneration** | `tools/refresh-region.sh`, and a line in `HANDOFF.md`. No plan. |
| **Light TODO** *(the default)* | An `## Open work` section in the reference doc that owns the area. |
| **Plan** | An issue here. Earns it only when the work is genuinely **multi-phase**. Cap active plans at **2–3**. |

Most work is not a plan. An `## Open work` row in `PLAN-PERF.md` beats a plan directory that only
points back at it.

## Identity — the issue number, claimed first

A plan's identity is its **`jjstwerff/routing` issue number**, not a local integer.

**Open the issue first, then name the directory after the number it returns.** Never pick the number by
scanning `plans/` — GitHub numbers are immutable, so a collision is expensive to unwind, and a sibling
branch may already hold an unmerged directory for it.

- Directory: `plans/<N>-<slug>/README.md` — **flat**. No `future/`, `finished/` or `deferred/`
  subdirectories: **lifecycle state is a label on the issue**, not a path.
- **Small plans live in the issue alone.** A directory is for work that needs document space (phases,
  sub-files). A plan with no directory is normal and correct.
- **No hand-maintained index here.** The overview is *derived* from the tracker:

```sh
gh issue list -R jjstwerff/routing --label plan --state all   # every plan
gh issue list -R jjstwerff/routing --label status:active      # what is in flight
```

⚠ **`HANDOFF.md` §1 is the hand-maintained open-work list this replaces.** While both exist, the issue
is the truth and `HANDOFF.md` is a convenience; a plan that is `status:active` and absent from
`HANDOFF.md` is fine, the reverse is drift.

## Labels

| Dimension | Values | Rule |
|---|---|---|
| kind | `plan` | on every plan issue (routing's tracker also holds bugs and data-quality reports) |
| status | `status:future` · `status:active` · `status:finished` · `status:declined` | **exactly one** |
| value | `val:S` `val:R` `val:G` `val:F` `val:U` `val:C` `val:Q` `val:N` | one, see below |

**A closed issue must carry `status:finished` or `status:declined` — never a live status.** This drifts
silently; when you touch a closed plan, check the label matches.

## Value categories — what KIND of value

Same letters as loft, crawler and moros, so the convention reads the same across repos. Read top-down
and pick from the highest category with open work.

| Tag | Meaning | routing examples |
|---|---|---|
| **S** | **Silent failure / wrong data** — it "works" and the answer is wrong, with no error | a block whose debut ladder was a no-op and still drew; a store read at the wrong stride returning garbage |
| **R** | **Regression / gate-blocker** — `make test` red, or a toolchain bump that breaks the build | a loft release that changes the store format |
| **G** | **Goal-enabling** — directly advances the product in `DESIGN.md` | the sketch editor, the signposted networks, a new activity |
| **F** | **Foundation** — unblocks 2+ downstream plans | the tile block format, the paged read path, the coverage ladder |
| **U** | **User experience** — what the map feels like to use | frozen frames on a phone, a seam through the viewport, an honest word where there is no data |
| **C** | **Clean features** — removes special cases; keeps the data↔render seam honest | one debut ladder instead of six copies |
| **Q** | **Internal quality** — perf, refactor, cleanup with a clear payoff | the corridor read, block size, gate speed |
| **N** | **Niche / opportunistic** — small, low-priority | one-off tools, conveniences |

**Effort letters, never calendar time** — `XS / S / M / MH / H / VH`. "Two weeks" ships in two days and
"quick" takes weeks; effort buckets stay stable, projections don't. This repo has its own evidence:
every dated estimate in the older `PLAN-*.md` files was wrong in one direction or the other.

## Closing a plan

1. Move any reference content out of the plan into the doc that owns it. A plan must not be the last
   home of a durable fact.
2. Rewrite links that pointed at the plan for its reference content.
3. Leave the closure record in the plan README: what shipped, what was dropped and why.
4. Set `status:finished` (or `status:declined`) and close the issue.

## Files here

| File | Purpose |
|---|---|
| `_TEMPLATE.md` | the standard plan skeleton — copy to `<N>-<slug>/README.md` |

**Length budget: 100–300 lines per plan README.** Longer means reference content is leaking in —
extract it to the doc that owns it.
