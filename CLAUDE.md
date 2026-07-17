# CLAUDE.md — working notes for agents on this repo

`routing` is a bicycle/pedestrian route-matcher written in **loft** (a bespoke Rust-like language).
It doubles as the **consumer test-bed** for loft, which is being given a formal language definition.
Start with **`HANDOFF.md`** (resume state) and the **`PLAN-*.md`** / `DESIGN.md` docs (plan of record).

These notes carry context that isn't obvious from the code, so it survives across machines. (They
mirror the maintainer's agent memory — keep both in sync when one changes.)

## Read the reference before you write — this is the expensive one

Two rules. Both were learned by an agent breaking them repeatedly in one session (2026-07-16), and
both are cheap to obey.

- **Load the `loft-write` skill BEFORE editing any `.loft` file** — not after something goes wrong.
  It is the reference for loft's types, syntax, naming rules, known bugs and error→fix table. Skipping
  it is the single most expensive habit available in this repo: that agent spent a day's probes
  rediscovering — and *filing to `docs/loft-feedback.md` as a finding* — the negative-index rule
  `loft-write` states verbatim (`v[-1]` is the LAST element, **not** null; when `i` can go negative test
  `if i >= 0` FIRST — that check is **not** redundant with a later null-guard). It also documents the
  vector-swap trap (#338), the hash-must-be-a-struct-field rule, and `const` freezing the *binding*, not
  the contents.
- **The authority is the reference doc — never a comment near the code.** Before concluding loft
  *cannot* do something, go read it:

  | question | where the answer actually is |
  |---|---|
  | a language / type / syntax rule | `loft-write` skill → `../loft2/doc/claude/LOFT.md` |
  | what the **browser** target can do | `../loft2/doc/claude/BROWSER_INTEROP.md` (+ `WEB_APPS.md`) |
  | a library's API / signature | `.loft/api/<name>.api`, or `loft api <name>` — **never guess** |
  | what landed in loft and why | the sibling trees' `git log` + `doc/claude/plans/` |

  *Earned:* that agent read *"`loft_start` rebuilds fresh Stores each call"* in
  `browser/store-kernel.mjs` and concluded the browser **cannot** hold state across calls and needs an
  upstream loft capability. `BROWSER_INTEROP.md` says the opposite — **loft owns the loop**,
  `frame_yield()` ships and is *proven* by `ztclient`'s `poll_for` — and its § *Rejected alternatives*
  names the one-shot "JS renders, loft computes" model the app is built on as the thing loft set aside.
  The agent then designed a Web Worker to fix a freeze `frame_yield()` already fixes. One file read
  would have replaced all of it. **If you are about to write "loft can't…", you owe the doc a look
  first.**

## Working agreements

- **Always push committed work to its branch; only open PRs when explicitly asked.** Pushing is a safety
  net (work isn't lost) and lets the maintainer switch machines/environments and pick the work up
  elsewhere — so push promptly after committing. But do **not** open a PR or run a
  verify-CI-till-green-then-merge loop for everything: only when told in those words, or for genuinely
  PR-worthy work.
- **`main` is protected — never push to it directly.** The repo is public and `main` requires a PR whose
  `build-test` CI check passes (enforced for admins too); direct pushes/merges are rejected. Do work on a
  branch, push the branch, and land it via PR when the maintainer says it's ready.
- End loft commit messages and PR bodies per the repo/CLI conventions already in use.

## The loft toolchain

- Build/test/run routing with the **installed `loft` on `PATH`** (`/usr/local/bin/loft`). It ships a
  stable, self-contained native runtime at `/usr/local/share/loft/deps`, so `--native` builds are
  reproducible. The `Makefile` defaults to `$(shell command -v loft)`; override with `LOFT_BIN=...`.
- Reach for the **sibling checkout's binary** (`../loft/target/release/loft`, via `LOFT_BIN=...`) **only
  when that dev build is ahead on a fix you specifically need.** Its `target/release/deps` is the other
  agent's *live, mid-build* tree — the binary can be byte-identical to the installed one yet the runtime
  is inconsistent. (2026-07-08: it held two `loft_ffi` rlibs and every routing `--native`/server build
  failed with rustc `found crates (loft_ffi and loft_ffi) with colliding StableCrateId`, exposed by loft
  #498's FFI-crate split; the installed loft built the same sources fine.)
- **`../loft` AND `../loft2` are other agents' workspaces** — each has its own agent, and both rebuild
  `target/release/loft` frequently. Treat both as **read-only**: never build, edit, `cargo build`, delete
  from their `target/`, or reinstall from them. Reading their git log / plan docs is fine and often the
  fastest way to learn what landed and how a routing finding was triaged.
- The loft binary is a **moving target — including mid-session.** When *every* loft run fails oddly (even
  hello-world), probe a trivial program first — and outside the Claude Code command sandbox — before
  believing any specific failure. (Past example: a build panicked at startup only inside the sandbox.)
  It is not just the sibling trees that move: **`/usr/local/bin/loft` gets reinstalled under you.**
  (2026-07-16: three distinct binaries existed within one session — `loft2` 16:50, installed 16:58,
  `loft` 17:47 — and both the installed binary and `../loft`'s dev build changed *while work was in
  flight*; a matrix probed at 16:00 described a binary that no longer existed by 17:00.) So: **anchor a
  finding to the binary you will report it against** — probe with `--version` + `ls -la` on the binary,
  and if it matters, re-run the probe on the *installed* loft before writing it down. A conclusion drawn
  from `../loft/target/release/loft` can be stale within the hour.

## loft's formal-definition goal

- The maintainer is driving a **formal language definition of loft**; routing is the dogfooding
  consumer that validates each formalized rule (nullable `v[i]`, fallible `as`-parse, the @PLN25/DN1
  non-null-by-default model) is ergonomically bearable.
- **So:** read loft-HEAD breakage here as a *data point against the formal model* (which rule landed,
  what the discharge idiom costs), not just a bug. Definition-relevant findings go in
  `docs/loft-feedback.md`. loft store/engine feature requests are filed as issues on **`loft-lang/loft`**
  (this repo's own remote is `jjstwerff/routing`).

## Measure before you design (the perf corollary)

The same "don't assert from a fragment" rule, applied to performance. All three of these came from one
session's design work and each would have sent the work at the wrong target:

- **A spec's premise goes stale.** `docs/loft-binary-bridge.md` was *correct when written* and wrong
  eight weeks later, because a different commit removed its justification. **Re-measure a doc's premise
  before building on it** — especially your own.
- **Measure the common case, not the outlier.** The profiler called a *cold full match* "match" and the
  design was ranked around it, when the interaction users actually perform (add/move one point) has an
  incremental path that already exists. A number measured on the wrong case is worse than no number.
- **Attribute per command, not in aggregate.** `view` loads layout+roads; `match` loads roads only. One
  probe that loaded both charged `match` 91 ms it never pays and hid the structural fact the whole design
  turns on (the 20 MB layout store is view-only).

## Accepted design decisions

- **Chord corridor** (`server/server.loft`, `match_for`): for a round-trip sketch, the Overpass
  corridor is queried around `sketch + finish→start chord` so the closing leg's region is downloaded.
  It was reverted once (2026-07-03) and then **explicitly re-requested** by the maintainer the same day
  — treat it as accepted design, not contested. Details in `PLAN.md` under "Bounded deviation-free
  closure".

## Environment / Claude Code notes

- **`gh` must run outside the command sandbox** (network to github.com is blocked inside it). Inside the
  sandbox, `gh auth status` falsely reports an invalid token — that's the sandbox network block, not a
  real auth failure; the token is fine. Run `gh` with the sandbox disabled.
- The browser shell (`browser/`) is **loft-native**: the wasm comes from `loft --html` and talks to JS
  over loft's own `host_input()`/`println` byte channel (no jco, no WASI, no npm deps). It needs `node`
  + a browser (headless Chromium for the gate). loft#521 (the wasm-runtime boot abort) is fixed.

## The standalone app's performance — read `PLAN-PERF.md` first

- **Plan of record: `PLAN-PERF.md`.** Its §0 is an executable 19-step list (one commit, one observable,
  gates green at every step). Everything below is summarised there with the measurements behind it.
- **The instrument is `tools/map_profile.sh`** — a CDP phase profiler over `_site`. **Always run it with
  `CPU_THROTTLE=4`** (≈ a mid-range phone, the target device); the desktop numbers flatter the app ~4×
  and make a broken interaction look like a nice-to-have. It attributes cost to store-load vs kernel vs
  JS-parse vs render, and `__perfHooks.frameBlocking` reports whether the main thread is *frozen*.
- **The app now runs loft's INTENDED model** — `loft_start` once, never returns; the kernel loops on
  `host_input()` and `frame_yield()`s (BROWSER_INTEROP's gather-until-enough). It used to run the
  one-shot model loft explicitly rejected, and that one fact explained every bad number: no session (a
  **full match on every click**, when `match_incremental`/`covered()` exist and `server.loft` already used
  them) plus a synchronous call on the UI thread (a phone **frozen 4.2 s** per click, 3 frames of 253).
  Fixed in PLAN-PERF steps 4–8; don't re-derive it.
- **Where it stands (2026-07-17, steps 1–16 done).** Measured at `CPU_THROTTLE=4`:
  a click that moves a point **4481 → 711 ms**; a repeat match **5274 → 339 ms** (15.6×); each store
  loaded **once per session** (2 fetches for 16 commands, was ~2 per command); and a real 40-point route's
  worst frozen frame **11095 → 744 ms**, because the route now **streams per stretch**. Route proven
  byte-identical throughout by `tools/match_parity.sh` (5 cases, 3 distinct routes) — that gate is the
  point, not the speed.
- **Still open:** the view path (steps 9–13, blocked on @PLN105 — see `docs/loft-feedback.md`: `expose`
  pins a store unreadable and a top-level `hash` will not deliver; the way through is per-tile `deliver`),
  the render budget (~13 fps panning, independent of loft), and `par` (steps 17–18: un-share `Scratch`,
  then parallelise — browser-gated on loft's C3).
- **The invariant to design against:** *every interaction does work proportional to what CHANGED, never
  to the size of the data. Never do everything again; build from what you have.* Every measured cost is
  one violation of it.
- **Don't reach for the @PLN105 `deliver` binary bridge first.** `docs/loft-binary-bridge.md` asks for it
  because `view` serialized ~230k features to text — but `199e7c7` (viewport-scoped `view`) already fixed
  that, so JS parse is now ~13% of a pan and **0% of a click**. loft shipped the bridge; it is simply not
  where the time is. `view` needs *less loft*, not a faster bridge: the layout store is **view-only**
  (match never loads it) and `view` is a bbox filter, not computation — **loft does the ROUTE, JS does
  the MAP.**
