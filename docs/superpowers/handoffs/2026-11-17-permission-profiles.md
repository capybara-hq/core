# Permission profiles: handoff, 2026-11-17

Supersedes the status sections of [2026-11-16-permission-profiles.md](2026-11-16-permission-profiles.md)
(keep reading that file for the approved product constraints; they all still apply). The ledger,
every task report and every independent review of this round are copied, unchanged, into
[2026-11-17-permission-profiles-evidence/](2026-11-17-permission-profiles-evidence/) — start with
`ledger.md` there. The working copies lived in the ignored `.superpowers/sdd/` directory.

Nothing is activated. The device wire is still protocol 2; every new path is dormant until Task 8.6.

## Standing rulings (do not re-ask)

- The maintainer approved the design and plans, asked for subagents and continuous work, and
  authorised merging ready PRs (own green PRs and the version PR). Feature work reaches `main` only
  through PRs; a feature branch merges only after its gates pass.
- 2026-11-16: the "PLATFORM HELD" Linux block in the older docs was a different AI platform's access
  control, not a project constraint. Task 2b was done for real (aarch64 locally, x86_64 on a GitHub
  runner) and merged to `main` (PR #336, SDK rc.27). Update the old HELD wording in the final doc pass.
- 2026-11-17: after the v3 cutover a local device with legacy background rows becomes available
  again only on authenticated boot-ID evidence (the host rebooted). Evidence is the OS instance, not
  the credential: any current machine of the device reporting a boot ID different from the one
  stored on the obligation resolves it. No owner manual override.
- Controller rulings recorded in `ledger.md`: broad legacy enumeration (one reboot per local device
  with legacy rows); unknown stored boot -> `device.replace_required` (delete and reconnect as a new
  device); cloud obligations with unknown incarnation resolve only on confirmed current destruction +
  no `prev_handle` + recorded after the freeze, else `device.recreate_required`; deleted devices ->
  `abandoned` (not `retired`; operator acknowledgement at the release gate); cutover order: ship the
  boot-reporting device build, wait for `report().localWithoutBoot` / `cloudUnknown` to empty, then
  publish the freeze; restricted network none/allowlist binds loopback only; the device package
  vendors its runtime closure (frozen per release, documented in docs/deploy/release.md).
- The user wants the final acceptance to be a real dogfood run: after everything is done, prepare
  steps for Capybara to do a small real development task on their Mac (three profiles, a background
  `pnpm test`, a replay eval afterwards). No intermediate trial.

## Where things are

Primary branch `docs/conversation-permission-profiles` (core), pushed at the commit that adds this
file. It contains, each independently reviewed and accepted: 8.1, 8.2, 8.3, 8.4 (A, B1, B2, B4),
9.2, 9.3, 9.5, 2b (+ x86_64 evidence), 10A–10D, plus fixes found by a full-suite run
(Redis-free CLI DI since Task 7, device runtime bundle 2 on macOS, error copy, flaky tests).
Last full-suite run on it: 12660 passed; remaining failures were load-only and passed on rerun.

Released to `main`/npm from this line: #320, #336 (Linux runtime + conformance), #338 (title
single-flight), #339 (conformance endpoint name/address), version PRs #316, #337, #340
(current: plugin-sdk rc.28, testing rc.22, kernel rc.37+).

### In flight (pushed branches; each needs the step listed)

| Branch | Repo | State | Next step |
|---|---|---|---|
| `perm/t8-5` (971dce894) | core | 8.5 legacy retirement + boot-ID evidence; review round 1 APPROVE; fix round 2 (cloud unknown, `abandoned`, flaky gateway test) committed, NOT yet re-reviewed | Scoped re-review of `2c19aef61..971dce894` by an independent reviewer (most capable model), then merge into the primary branch, full-suite check, push |
| `perm/t10e` (780ce49bf) | core | 10E owner ceilings replace the daily device mode (web); review was interrupted by a rate limit before reporting | Run the independent review (brief: task-10e-report.md + the plan's Slice E; check no web path widens a local ceiling, cloud widening only via confirmation, `capybara-device mode` CLI still exists), fix, merge into primary |
| `feat/sandbox-docker-permission-scopes` (8bf494b) | plugins | Task 12 Docker provider; security reviews round 1 and 2 APPROVE; fix round 3 (R7 pre-connect race, migration to testing rc.22 / sdk rc.28 with `access: "proxy"`) committed; final re-review was interrupted by a rate limit | Run the scoped re-review of `cfbbb02..8bf494b` (re-attempt the R7 attack), then open the plugins PR, CI, merge; the image must be released before production use |

Never use bare `git stash` in these repos (the stack is shared); use WIP commits.

### Not started (in plan order)

1. **Gate 9.4** — wire the recorder into every model request (model-call callback, run-steps,
   managed-device-context module, the Task 8 shared edit in tools.module/builtin-tools/common.ts and
   sandbox.service contextEvidence). Wait for 8.5 to merge (sandbox.service overlap). Carries: 9.5
   F1/F2 flip (target-run context must reach generated requests), F3 spy list, 9.3 M2 (admission
   shares readAppliedEnvironmentLocked), M7 (eval refusal checks the root).
2. **Task 13** — E2B provider on the existing template (plugins). Live tests need the configured
   test credential file (never print it); record and delete the exact owned VM.
3. **Task 8.6** — atomic paired v3 activation and legacy removal. Clear the activation blocker list
   in `ledger.md` first (8.1 M8/N1/N2/graceMs; B3 disconnect/reconnect revocation and platform
   writer e2e; B4 runtime closure verify->launch TOCTOU and bind/legacy-gate wiring; B1 snapshot
   driver, acquire-path reconcile check, provider outer-limit comparison; 9.3 M1 cloud context
   evidence; launcher non-dumpable vs same-uid ptrace; suspended-cloud exact cancel on resume;
   10E kernel gaps: reconcile state in the device view, owner_ceiling_changed in MODE_CHANGE_ACTIONS,
   B2 M6 new-install default `{false, workspace}`; production wiring of commands/start binder,
   DevicePolicyService v3 send, gateway connectionId).
4. **Task 14** — cross-runtime product acceptance (local macOS, Docker, E2B; Linux local).
   Includes M5 (Full shares the device uid: it can signal/ptrace other sessions' processes) and
   confirming the kernel never leaks execution UUIDs.
5. **Task 15** — `CAPYBARA_TEST_WORKERS=4 pnpm verify` on the final branch, visual-update for the
   web baselines, PRs (core feature PR from the primary branch; plugins provider PRs first), release,
   then hand the user the dogfood acceptance steps.

Also open: investigate why `reconstruct.test.ts` ("clamped output cap") failed once under load (a
zero-drift test should not be timing-dependent); `channels/supervisor-share.dual` flake belongs to
another line (report, don't fix here).

## How to work

Machine load matters: run tests with `CAPYBARA_TEST_WORKERS=2` and small batches; Docker suites
sequentially. Each task: implementer subagent in its own worktree (`pnpm wt:new <branch> --from
origin/docs/conversation-permission-profiles`), RED first, report; independent review by the most
capable model for trust-boundary/migration/multi-replica work; fix rounds until APPROVE; merge into
the primary branch, run typecheck/check/unit plus the affected suites, push. Record decisions in the
ledger (copy it back into this evidence directory when handing off again).
