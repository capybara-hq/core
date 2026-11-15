# Project file read mode implementation plan

**Goal:** Load a permitted local project before its first command, without relying on cached mode.
**Spec:** ../specs/2026-11-15-project-file-read-mode-design.md

- [x] Reproduce first-read rejection and stale-decision widening in device regression tests.
- [x] Require current read ceilings in protocol v2 and route reads by the stricter current mode.
- [x] Carry the live org ceiling in the kernel local provider; leave sandbox@2 and writes unchanged.
- [x] Verify SDK API, device/kernel tests, old-client rejection and repository checks.
- [x] Restart the development kernel and registered device with the matching local source build.
- [x] Verify actual project metadata and AGENTS.md through the registered device.

## Validation evidence

- Device regression tests reproduced the first-read denial and stale wider command decision before
  the fix. Targeted device, SDK and local-device suites passed after the protocol fixture updates.
- Independent read-only review found no blocking defect in the mode boundary or protocol gates.
- The locally rebuilt kernel and registered Mac device connected using protocol v2. A live project
  knowledge read through the gateway relay loaded `core`, 19,085 characters of AGENTS.md and 15
  skills with 22 file requests and zero exec requests. No conversation events were rewritten.
- The development web stays on the approved notice UI worktree; the kernel and foreground device
  use this fix worktree. The installed device login service is stopped during this source-build
  validation, retaining its original configuration and credentials.

- `CAPYBARA_TEST_WORKERS=4 pnpm verify` passed: lint, typecheck, custom checks and
  11,482 tests across 749 passing files; 53 tests / two files were skipped by the suite.
  Verify reported five passing stages, zero failures and zero warnings; CI-only e2e/docker
  stages were skipped locally. The final `git diff --check` and local `/readyz` also passed.
