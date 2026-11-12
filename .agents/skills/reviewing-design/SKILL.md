---
name: reviewing-design
description: Use when the maintainer asks for a design review, a whole-platform inventory or health check of Capybara (core plus the plugins repository), or asks whether the design has flaws, drift, over-engineering, special-case patches, outdated dependencies, or cross-module damage from recent iterations. Not for reviewing a single PR (reviewing-prs) or a diff (code-review).
---

# Reviewing the design

A manual, whole-platform design review. A PR review sees only its diff; this review looks for what
no diff shows: the same fact modelled in several places, a later feature breaking an earlier rule,
a local patch over a missing model, scope spent away from the core, dependencies gone stale.

The output is a fix list the maintainer approves item by item. **The review never fixes anything
itself.** Approved items then go through the normal flow (small fix directly; larger change: spec,
plan, implementation, per AGENTS.md "How work is done").

## The yardstick

Judge every candidate against the platform's goals: a solid, extensible, usable enterprise agent
platform; multi-tenant, multi-replica, plugin-extensible, usable by members, org admins and the
super admin; plus the rules in AGENTS.md (pre-0.1.0: no compatibility layers).

Each candidate ends in exactly one of two outcomes:

| Outcome | When | Where it goes |
|---|---|---|
| **Reasonable** | It serves the goals and you can say why in one sentence | "What is solid", with that sentence |
| **Finding** | It does not | The fix list, **with a concrete fix proposal** |

"Known risk", "accepted trade-off", "by design" and "acceptable for now" are not outcomes. A
deliberate design choice that still causes a real problem is a finding with a proposal; so is a
decision a reviewed spec made against AGENTS.md or the goals (the fix then includes amending that
spec). A finding without a fix proposal is not done.

## Process

1. **Baseline.** Read the latest `docs/reviews/*-design-review.md` (if any): its HEAD commits and
   its findings. Record the current HEAD of core and of the plugins checkout (sibling `../plugins`;
   ask if missing). Collect the numbers in [lanes.md](lanes.md) "Baseline numbers".
2. **Fan out the lanes** in [lanes.md](lanes.md) as parallel read-only subagents (most capable
   model), each with the brief in [reviewer-brief.md](reviewer-brief.md) filled in. Give each lane
   the previous review's findings for its area. If the repository map has changed, re-cut the lanes
   from AGENTS.md's map first so no top-level area is left out.
3. **Verify.** Open the code for every high and medium finding yourself. A claim you cannot confirm
   is dropped or marked "unverified"; never report a lane's claim on trust. Merge duplicates found by
   several lanes into one finding (keep the strongest evidence).
4. **Match to the previous review** by finding id (see [report-template.md](report-template.md)):
   each finding is `new`, `recurring` (count and first-seen date) or `regressed` (was fixed). Every
   previous finding not seen again is checked in code: `fixed` only when confirmed.
5. **Write the report** to `docs/reviews/YYYY-MM-DD-design-review.md` in a worktree branch
   (`pnpm wt:new docs/design-review-YYYY-MM-DD`), English, shaped by
   [report-template.md](report-template.md). Commit or open a PR only when the maintainer asks.
6. **Hand over** to the maintainer in their language: the report path; the themes (root causes that
   explain several findings); the findings ranked, each with status, evidence, fix proposal and
   size; what was fixed since last time. "Reasonable" and the baseline numbers stay in the file.
   **Stop and wait** for the maintainer to pick what to fix.

## Common mistakes

| Mistake | Fix |
|---|---|
| Listing 60 symptoms | Group them under the few root causes that produce them; fix the cause |
| "Known risk, documented" | Reasonable (say why) or a finding with a proposal; nothing in between |
| Reporting a lane's line numbers unchecked | Step 3: open each one |
| Dropping last review's unfixed findings because they are old | They recur, with their count, until fixed |
| Reviewing only what changed | The cross-module lane covers changes; the other lanes cover everything |
| Starting fixes after the report | Stop; fixes start only on the maintainer's pick |
