---
"@capybara-hq/kernel": minor
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

Platform tool phase 2, foundations:

- **Shared schemas.** Operations build their input from their route's exported schema. A parity
  test fails when they drift apart: a type, bound, pattern or required field, a nested or renamed
  field, or an undeclared omission or extra. Deliberate differences are declared with `omits`,
  `extras`, `renames` and `loosens`.
- **Checks before the card.** Writes run a read-only `precheck` before the confirmation card. When
  the write is known to fail, the tool returns the reason and no card appears. The precheck runs
  again on resume after approval.
- **Errors with a next step.** Errors name the next step for the actor's role (super admin, org
  admin or member). `check:platform-ops` gains `platform-op-errors`.
- **Why an extension is unavailable.** An installed extension that is not loaded now says why. The
  org extensions API gives its deployment `status` and a `reason`, such as
  `needs_deployment_config`, `pending_approval` or `failed`. A plugin not on in the org whose
  extension cannot run is `unavailable` with the same reason.
  - The 扩展 and 插件 pages show it (不可用 · 缺少部署配置) with the next step for the viewer's
    role. The super admin also gets the admin console link.
  - `plugins.set-enabled` refuses such a plugin before the card.
  - `plugins.list` and `extensions.list` return compact rows with `state`, `reason` and `next`.
