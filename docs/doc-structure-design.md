<!-- Copyright (c) 2026 Jurjen Stellingwerff
     SPDX-License-Identifier: LGPL-3.0-or-later -->
# A documentation structure that stays correct

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-07 · **Owns:** why the docs are organised the way they are, and what tools/docs_gate.sh enforces

**Written 2026-08-07 · steps 1–4 EXECUTED the same day; 5–7 open — see §6.** Discovery is done: the
index is complete and gated, every doc declares itself, and nothing was renamed. What is left is the
layout, which migrates one doc at a time.

This is how routing's docs are organised so they are **clear, complete and findable**. It was written
against measured defects in the tree, not against a preference for tidiness.

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

One header line on every file, so status is readable **without `git`** — the defect that let a
month-old plan read like this morning's:

```markdown
**Kind:** reference · **Status:** current · **Last verified:** 2026-08-07 · **Owns:** how a viewport
picks its tiles and what each layer costs
```

`Kind` is one of `state` · `reference` · `plan` · `guide`. `Status` is one of `current` ·
`stale — unverified since <date>` · `superseded by <path>`. `Owns` may wrap; the header ends at the
first blank line.

**`Last verified` means someone RE-CHECKED the claims**, not that the file was edited — this repo has
already been bitten by a doc that was correct when written and wrong eight weeks later
(`docs/loft-binary-bridge.md`, whose premise a later commit removed). ⚠ **The dates this landed with
are each doc's last substantive edit, adopted as a lower bound** — that is the only thing the tree
actually knows, and it errs toward *older than it says*, which is the safe direction. The first person
to genuinely re-check a doc moves its date to that day; a typo fix never touches it.

**The four files a stranger arrives at carry the same header as an HTML comment** — `README.md`,
`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `ATTRIBUTION.md`. A currency banner addressed to us is noise
addressed to them, and exempting the front page from the rule would have been the bigger hole:

```markdown
<!-- Kind: guide · Status: current · Last verified: 2026-08-03 · Owns: what routing is -->
```

---

## 5. It is gated, or it rots again

Every defect in §1 is mechanically detectable, and *"a probe outside a gate is a comment"*.
`tools/docs_gate.sh`, in `make test` (it needs no loft, no browser and no data):

1. **No orphans** — every `*.md` appears in `HANDOFF.md` §4. *Would have caught all five missing files.*
2. **No dangling pointers** — every `path/to.md` cited in any doc exists. *Catches a rename that missed a caller.*
3. **Headers present and parseable** — kind, status, last-verified, owns on every file.
4. **Staleness is declared, not discovered** — a doc whose `Last verified` is >90 days old must say
   `stale`, or the gate fails. It never fails for age alone; it fails for a **silent** claim of currency.
5. **Budgets** — a plan over 300 lines, or a reference doc over ~800, fails with "split or move dated
   narrative to STATE". *`PLAN-SCALE` and `PLAN-PERF` are 2 238 and 2 229.*

⚠ **Rule 1 is the one that pays for itself immediately**, and rule 5 is the one to introduce last —
turning it on today fails two files that nobody has time to split this week. **Land the gate with rule
5 warning-only**, and promote it when the split happens.

### What building it added — and it is not decoration

**Rule 2 needed a definition of *ours*, and the measurement supplied it.** Of the 65 distinct `*.md`
citations in the tree, **30 name a doc in another repo** (`LOFT.md`, `WEB_APPS.md`,
`doc/claude/PACKAGES.md` — the loft reference `CLAUDE.md` sends you to) or a template slot
(`plans/<N>-<slug>/README.md`). A rule that flagged those would bury the two real hits. So a citation is
ours when its first path segment is a directory that exists here, or when it is a bare name in this
repo's root-doc shape — which is what still catches `PLAN-ROUTING.md`.

**`tools/docs_gate.exempt` — four columns, and the fourth is the reason.** Every entry is a place where
a rule and a standing convention disagree, and the reason is the resolution. There are five, and each
one is a decision worth seeing rather than a hole worth hiding:

| exemption | the convention it yields to |
|---|---|
| active plan READMEs, from rule 1 | `plans/README.md`: *"No hand-maintained index here. The overview is DERIVED from the tracker."* A second hand-kept list would drift exactly as the first did |
| §3's target names, from rule 2 | they are the *migration targets*; scoped to `docs/reference/` and `docs/archive/`, so a typo elsewhere in this file still fails |
| the promoted plan's old name, from rule 2 | it is the former name of `plans/50-get-me-there/`, only ever cited as history — the file is correctly absent and the sentences are correctly there |
| `docs/loft-feedback.md`, from rule 5 | append-only by design, like the archive: the ORDER is the record, and upstream issues cite it by date |

**`tools/docs_gate_selftest.sh` — 14 cases, and it found a bug on its first run.** A gate that has only
ever been seen to pass is a gate nobody knows the reach of. It builds a throwaway repo per case, injects
exactly one defect, and asserts the verdict. Two of the cases exist because the first version of the
gate got them wrong:

- **`Last verified: last Tuesday` passed.** GNU `date -d` parses English — `yesterday`, `now`,
  `last Tuesday` all succeed and yield a *moving* target. The shape check is not redundant with the
  parse.
- **The root `README.md` counted as indexed** because §4 names `plans/README.md`. A substring match
  silently exempts the front page; the fix is a boundary class that excludes `/`.

And two exist to stop the gate rotting into false safety: **age alone must never fail** (a doc that
honestly says `stale` passes, or people will date-stamp docs they have not read just to get green), and
**another repo's docs are not ours to resolve**.

---

## 6. Order of work

Discovery first, because it costs nothing and fixes what hurts today. Layout last, because
`plans/README.md` says **migrate opportunistically, never in a sweep** — and a 17-file rename would
break every cross-reference in one commit.

| # | step | ships |
|---|---|---|
| 1 | ✅ **done 2026-08-07** — §4 rewritten complete, grouped by question | findability, immediately |
| 2 | ✅ **done 2026-08-07** — `tools/docs_gate.sh` rules 1–5 + `tools/docs_gate_selftest.sh`, both in `make test` | the index can never silently rot again |
| 3 | ✅ **done 2026-08-07** — headers on all **38** docs (26 was an undercount: `browser/`, `tools/loft_repro/` and the four public files were not in the census) | staleness visible without `git` |
| 4 | ✅ **done 2026-08-07** — rule 4 on; **6** marked stale: `PLAN.md`, `PLAN-BROWSER.md`, `PLAN-BUILD.md`, `PLAN-STORE.md`, plus `docs/loft-binary-bridge.md` and `docs/loft-build-phase-adoption.md` | no doc silently claims to be current |
| 5 | `docs/` subdirectories; move the 8 existing `docs/` files first — **but see the warning below** | the shape exists before the big files move |
| 6 | Migrate one root `PLAN-*.md` per session **as you touch it**, updating §4 in the same commit | no flag day |
| 7 | Rule 5 from warning to failing, once `SCALE` and `PERF` are split | budgets hold |

**Steps 1–4 shipped in one session, and delivered the whole benefit** — complete, verifiable,
self-describing — with **zero renames** and therefore zero broken references. `make test` now fails on
a doc that is unlisted, unlabelled, dangling, or silently claiming to be current.

⚠ **Step 5 is not the free hour this table implied, and the reason is `docs/loft-feedback.md`.** Its
path is cited from **outside this repo** — the loft-lang/loft issues that routing files findings against
say *"filed in `docs/loft-feedback.md`, <date>"*, and nothing here can rewrite those. Moving it to
`docs/upstream/` breaks the one class of reference the gate cannot check and nobody can fix. Either it
stays put while the other seven move, or step 5 accepts that cost knowingly. The same question applies,
more weakly, to `docs/ARCHITECTURE.md`, which `README.md` links for the public.

**Three docs are over budget and warn today** (rule 5): `PLAN-PERF.md` 2 231, `PLAN-SCALE.md` 2 240,
`plans/51-coverage-past-nl/README.md` 410. The third is new information — a *current* plan already
past the 300-line budget, which is the leak `plans/README.md` predicted, caught while it is still
cheap to fix.

---

## 7. What this deliberately does not do

- **No sweep.** `plans/README.md` forbids it and it is right: a mass rename invalidates every path in
  every doc, the archive, and 200 commit messages that cite them.
- **No new taxonomy.** The kinds come from `plans/README.md`. This adds only STATE and GUIDE, which
  existed unnamed.
- **No content rewriting.** Everything above moves or labels text. The measurements are the asset.
- **No tooling beyond one shell gate.** A generated index was considered and rejected: §4's value is
  the one-line *"what it owns"* prose, which no generator can write.
- **No date in two places.** §4 used to carry a per-doc date; the header now owns it, and §4 dropped
  it. Two copies of one fact is the thing certain to drift — `tools/gates.offline` says so about
  itself. §4 flags ⚠ only where a doc's answer to *"does anyone still stand behind this?"* is no.

---

## 8. What is left

Steps 5–7 are housekeeping, and nobody is waiting on them. Migration happens **one doc per session, as
you touch it** — `plans/README.md` forbids the sweep and is right.

If steps 5–7 ever get scheduled rather than drifted into, that is multi-phase work and earns a plan —
**but the identity is the issue number, claimed first**. Open an issue on `jjstwerff/routing`, then
`plans/<n>-doc-structure/`, and move §§3 and 6 into it, leaving this file as the reference on *why the
structure is what it is*. Steps 1–4 needed none of that: they were a bug fix with a gate, which the
workflow table calls **"Fix + a gate that would have caught it + commit. No plan, no issue."**
