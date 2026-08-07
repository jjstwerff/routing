<!-- Copyright (c) 2026 Jurjen Stellingwerff
     SPDX-License-Identifier: LGPL-3.0-or-later -->
# A documentation structure that stays correct

**Status:** design, not yet executed · **Written:** 2026-08-07 · **Owner:** unclaimed

This proposes how routing's docs should be organised so they are **clear, complete and findable**. It
is written against measured defects in the current tree, not against a preference for tidiness.

⚠ **The taxonomy already exists and is right.** `plans/README.md` defines *reference doc* vs *plan*,
budgets a plan at 100–300 lines, and already predicts the outcome: *"most of them will end up as
reference docs with an `## Open work` section rather than as plans, because that is what they actually
are."* **Nothing below invents a new scheme.** The problem is not the taxonomy; it is that the
reference layer never got one, and that nothing enforces either.

---

## 1. What is actually wrong (measured 2026-08-07)

| defect | evidence |
|---|---|
| **The index was incomplete, while the text told you to read what it omitted** | `HANDOFF.md` §4 listed neither `PLAN.md` (547 lines) nor `PLAN-STORE.md`, and **5 of 8 `docs/` files** — including `hosting-cost-model.md` and `prefetch-index-design.md`, which §0 and §1 explicitly say to read |
| **Names are by ARTIFACT, so a name does not answer a question** | four docs cover what draws (`LAYERS`, `BASEMAP`, `MAP`, `TILES`); two cover the browser app (`APP`, `BROWSER`), written a month apart |
| **Docs contradict each other and the state file** | §2 said `store-kernel.wasm` *"STAYS on the older runtime"* while §0 said the pin was lifted; §0 said the site was 664.9 MB while §1 said 673.8 MB — same file |
| **Staleness is invisible without `git`** | `PLAN.md` (07-03) and `PLAN-BROWSER.md` (07-06) read exactly like `PLAN-SCALE.md` (08-04) |
| **State leaks into reference docs and back** | `HANDOFF.md` reached 758 lines — a file whose own header says "deliberately short" — because dated session accounts accumulated in it |
| **Root sprawl, against the convention we claim to follow** | routing **17** root `.md`; `../loft` **5**, `../moros` **1**, both with the reference layer under `doc/claude/`. `../crawler` has 28 and the same symptom |

**The through-line: every one of these is a discovery or a consistency failure, not a content failure.**
The content is good and expensively earned. Nobody can reliably *find* it or *tell whether it still
holds*.

---

## 2. The four kinds, and the one question each answers

Everything in the tree is exactly one of these. Two already exist in `plans/README.md`; naming all four
is what lets a rule be written per kind.

| kind | answers | lifetime | where |
|---|---|---|---|
| **STATE** | *where are we, how do I resume?* | rewritten continuously; never accumulates | `HANDOFF.md` (+ `docs/archive/`) |
| **REFERENCE** | *how does this work, and what did it cost?* | durable, updated in place | `docs/reference/` |
| **PLAN** | *what are we about to change?* | temporary; closes into a reference doc | `plans/<issue>-<slug>/` |
| **GUIDE** | *how do I work in this repo?* | durable | `CLAUDE.md`, `plans/README.md` |

**The rule that prevents the mixing we have:** a REFERENCE doc may hold an `## Open work` section, but
never a dated narrative — those belong in STATE, and STATE drains into the archive. `PLAN-SCALE.md` is
2 238 lines because it is all four kinds in one file.

---

## 3. Target layout

Root keeps only what a newcomer opens first — matching `../loft` and `../moros`:

```
README.md          what this project is (public)
DESIGN.md          the north star — what the product is
HANDOFF.md         STATE: where things stand, how to resume
CLAUDE.md          GUIDE: how to work here

docs/
  reference/       how it works + what it cost   <- the 16 root PLAN-*.md land here
  decisions/       costed choices: hosting-cost-model, prefetch-index-design
  ops/             ARCHITECTURE, debug-websocket
  upstream/        loft-feedback, loft-binary-bridge, loft-build-phase-adoption
  archive/         handoff-archive, superseded plans
plans/<issue>/     active multi-phase work (unchanged — it already works)
```

**Renames answer the question, not the artifact.** The map is one subject in four files today:

| today | becomes |
|---|---|
| `PLAN-LAYERS.md` + `PLAN-BASEMAP.md` + `PLAN-MAP.md` + `PLAN-TILES.md` | `docs/reference/map-drawing.md` (+ `map-data.md` if it will not fit a budget) |
| `PLAN-APP.md` + `PLAN-BROWSER.md` | `docs/reference/browser-app.md` |
| `PLAN-SCALE.md` | `docs/reference/data-pipeline.md` |
| `PLAN-PERF.md` | `docs/reference/app-performance.md` |
| `PLAN-MATCH.md` / `PLAN-EDIT.md` / `PLAN-RESTORE.md` | `docs/reference/routing.md` / `sketch-editor.md` / `restored-features.md` |
| `PLAN-BUILD.md` + `PLAN-STORE.md` | `docs/reference/build-toolchain.md` |
| `PLAN.md` | `docs/archive/original-plan-2026-07.md` |

---

## 4. Every doc declares itself

A four-line header on every file, so status is readable **without `git`** — the defect that let a
month-old plan read like this morning's:

```markdown
**Kind:** reference · **Status:** current · **Last verified:** 2026-08-07 · **Owns:** how a viewport
picks its tiles and what each layer costs
```

`Status` is one of `current` · `stale — unverified since <date>` · `superseded by <path>`.
**`Last verified` means someone RE-CHECKED the claims**, not that the file was edited — this repo has
already been bitten by a doc that was correct when written and wrong eight weeks later
(`docs/loft-binary-bridge.md`, whose premise a later commit removed).

---

## 5. It is gated, or it rots again

Every defect in §1 is mechanically detectable, and *"a probe outside a gate is a comment"*.
`tools/docs_gate.sh`, in `make test` (it needs no browser and no data):

1. **No orphans** — every `*.md` appears in `HANDOFF.md` §4. *Would have caught all five missing files.*
2. **No dangling pointers** — every `path/to.md` cited in any doc exists. *Catches a rename that missed a caller.*
3. **Headers present and parseable** — kind, status, last-verified on every file.
4. **Staleness is declared, not discovered** — a doc whose `Last verified` is >90 days old must say
   `stale`, or the gate fails. It never fails for age alone; it fails for a **silent** claim of currency.
5. **Budgets** — a plan over 300 lines, or a reference doc over ~800, fails with "split or move dated
   narrative to STATE". *`PLAN-SCALE` and `PLAN-PERF` are 2 238 and 2 229.*

⚠ **Rule 1 is the one that pays for itself immediately**, and rule 5 is the one to introduce last —
turning it on today fails two files that nobody has time to split this week. **Land the gate with rule
5 warning-only**, and promote it when the split happens.

---

## 6. Order of work

Discovery first, because it costs nothing and fixes what hurts today. Layout last, because
`plans/README.md` says **migrate opportunistically, never in a sweep** — and a 17-file rename would
break every cross-reference in one commit.

| # | step | cost | ships |
|---|---|---|---|
| 1 | ✅ **done 2026-08-07** — §4 rewritten complete, grouped by question | — | findability, immediately |
| 2 | `tools/docs_gate.sh` rules 1–3, in `make test` | ~1 h | the index can never silently rot again |
| 3 | Headers on all 26 files | ~1 h | staleness visible without `git` |
| 4 | Rule 4 on; mark the genuinely stale ones (`PLAN.md`, `PLAN-BROWSER.md`, `PLAN-BUILD.md`, `PLAN-STORE.md`) | ~30 min | no doc silently claims to be current |
| 5 | `docs/` subdirectories; move the 8 existing `docs/` files first (they have few inbound links) | ~1 h | the shape exists before the big files move |
| 6 | Migrate one root `PLAN-*.md` per session **as you touch it**, updating §4 in the same commit | ongoing | no flag day |
| 7 | Rule 5 from warning to failing, once `SCALE` and `PERF` are split | — | budgets hold |

**Steps 2–4 are the design's core and take an afternoon.** They deliver the whole benefit — complete,
verifiable, self-describing — with **zero renames** and therefore zero broken references. Steps 5–7 are
housekeeping that can take months without anyone waiting on them.

---

## 7. What this deliberately does not do

- **No sweep.** `plans/README.md` forbids it and it is right: a mass rename invalidates every path in
  every doc, the archive, and 200 commit messages that cite them.
- **No new taxonomy.** The kinds come from `plans/README.md`. This adds only STATE and GUIDE, which
  existed unnamed.
- **No content rewriting.** Everything above moves or labels text. The measurements are the asset.
- **No tooling beyond one shell gate.** A generated index was considered and rejected: §4's value is
  the one-line *"what it owns"* prose, which no generator can write.

---

## 8. If this becomes work

It is genuinely multi-phase, so by `plans/README.md` it earns a plan — **but the identity is the issue
number, claimed first**. Open an issue on `jjstwerff/routing`, then `plans/<n>-doc-structure/`, and move
§§3–6 into it, leaving this file as the reference on *why the structure is what it is*.

Steps 2–4 do not need any of that: they are a bug fix with a gate, which the workflow table calls
**"Fix + a gate that would have caught it + commit. No plan, no issue."**
