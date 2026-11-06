---
name: wave-planned-subagent-development
description: Use when executing an implementation plan with superpowers:subagent-driven-development and the plan has more than about five tasks, or when strictly one-task-at-a-time execution with a review and fix loop per task is too slow
---

# Wave-planned subagent development

## Overview

A layer on top of superpowers:subagent-driven-development (SDD). **REQUIRED SUB-SKILL:** use it for
everything this skill does not override: ledger, briefs, report files, the review package, the
rulings and stop rules, and the final whole-branch review.

Core principle: plan the execution of the whole plan before the first dispatch. Run tasks in
**waves**: independent tasks run in parallel, a wave is reviewed together and fixed together, and
review effort follows risk.

## The wave plan (write it to the ledger before Task 1)

One table row per task:

| Task | Depends on (interfaces) | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|

- **Risk** is `high` when the task touches a trust boundary (auth, permissions, code execution,
  secrets), a data migration, multi-replica concurrency or a cross-tenant rule. Otherwise it is
  `normal`.
- **Wave**: a task joins the earliest wave after every task it depends on, and only if its files are
  disjoint from every other task in that wave. Shared files mean the tasks are in different waves.
- **Review**: a `high` task is reviewed on its own by the most capable model. `normal` tasks in a wave
  share one batched review. Split a batch by area when its diff is over about 3k changed lines.

## Running a wave

1. Record BASE. Dispatch one implementer per task in the wave **in one message** (parallel). Each
   brief names the files the task owns. The implementer stages only those paths (`git add <paths>`)
   and commits only its own work. Give tasks that would collide in the index separate git
   worktrees, and merge or cherry-pick them back in task order.
2. When all the wave's implementers have reported, build one review package BASE..HEAD for the wave,
   plus one per `high` task (its own commits only). Dispatch the reviewers in parallel.
3. Send **one fix dispatch per implementer** with all of its findings from every review. Then run one
   scoped re-review per wave, on a mid-tier model.
4. Fold Minor findings into the next task that touches the same file and record that in the
   ledger. Important and Critical findings are fixed in this wave.
5. Ledger: `Wave N: tasks a,b,c complete (commits …)`. Then start the next wave.

## Model tiers

| Role | Model |
|---|---|
| Implementer, `high` or judgment-heavy | most capable |
| Implementer, mechanical or UI copy | mid / cheap |
| Review of a `high` task, final review | most capable |
| Batched `normal` review, re-review | mid |

## Common mistakes

- Treating a wave as a single task. Each task keeps its own brief, report and commits.
- Batching a `high` task into a wave review. A large diff makes the review shallow exactly where it
  matters.
- Putting two tasks that edit the same file, such as i18n message files or a route table, in one
  wave. Either serialize them, or give one task ownership of the shared file and have the others
  hand it their lines.
- Letting parallel implementers run `git add -A` or `git commit -a`.
- Starting the next wave before the current wave's Important findings are fixed.
