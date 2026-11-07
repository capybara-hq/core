# Phase 1 follow-ups and the super admin / platform rename

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** finish the follow-ups decided during the phase 1 acceptance and rename the deployment layer
(enterprise admin → super admin, enterprise → platform) in code, API, data, docs and UI, before phase 2.

**Spec:** `docs/superpowers/specs/2026-11-05-plugin-component-management-design.md` §13 (13.1-13.4c).
Written and executed without maintainer review (authorized 2026-11-06); every decision not in the spec
is recorded as a ruling in the SDD ledger.

## Global Constraints

- Everything stays local: no push, no PR, no npm publish, in core and in `capybara-hq/plugins`.
- Migrations: next number `0080`; renames follow the precedent of `0043_rename_app_installs_to_plugin_installs.sql`
  (rename in place with an exemption comment, data updated in the same file); expand-only otherwise.
- No compatibility aliases for renamed API fields, error codes, CLI flags or config keys (rc, as decided
  for the 2026-10-24 terminology refactor); historical specs and plans are not edited.
- New names: `superAdmin` / `SuperAdmin` / `super_admin` / 超级管理员 / Super admin; owner layer
  `platform` / 平台 / Platform; roles 组织所有者 / 组织管理员 / 组织成员 / 访客 (en Org owner / Org admin /
  Org member / Guest); agent → 智能体 in zh only.
- `check:terms` (terms-reference) and `check:i18n` guard the old names after the rename.
- Kernel conventions, web rules, SDK API snapshot + changeset rules of AGENTS.md apply.

---

### Task F3: the kernel refuses connector kinds not enabled in the org

`ConnectorsService.create` / the preview refuse a kind whose providing extension is not in the org's
enabled set (`extensions/enabled.ts`) with the existing "kind unavailable" error (or a new
`connector.kind_disabled` 409 if none fits). Tests: kind loaded but switched off in the org → refused;
switched on → created.

### Task F4: marketplace format (core: SDK, plugin-tools, kernel, web)

- SDK: `plugin.json` `description` accepts `string | { en, zh? }` (a string is `en`); marketplace entries
  accept optional `displayName: { zh, en }`; regenerate JSON schemas (`pnpm gen:package-schemas`) and the
  API snapshot (`pnpm gen:sdk-api`); changeset bumping `@capybara-hq/plugin-sdk`.
- plugin-tools `marketplace --write`: one entry per plugin (its current version), `summary` from the
  localized description, `displayName` from `plugin.json`; `--base` rules: `marketplace-version-decrease`
  (an entry's version may only increase), `marketplace-integrity` (same version keeps its integrity);
  remove `marketplace-append-only`; red fixtures for the new rules. `check` warns (not fails) when a
  public plugin's description lacks `zh`.
- Kernel: marketplace entries carry `displayName` through to the API; plugin import reads a localized
  description (catalog item `description` stays the en text; add `descriptionZh` or a localized field
  if the web needs it — builder's call, recorded).
- Web: market rows show the display name (else the name) and the zh summary in zh.
- AGENTS.md and writing-plugins skill: the marketplace bullet rewritten (one entry per plugin).

### Task F5: the plugins repository (local branch)

In `/Users/grant/Capybara/plugins`, a worktree on a new local branch `feat/localized-marketplace`:
Chinese descriptions for every public plugin (`plugin.json` `description: { en, zh }`), regenerate
`.capybara-plugin/marketplace.json` with core's plugin-tools run from source, run the repository's
checks with that source build. Nothing pushed or published; the official marketplace on GitHub is
unchanged until the maintainer releases.

### Task R1: kernel, data and API rename

DB column `is_enterprise_admin` → `is_super_admin` and stored values (`orgCreation: "enterprise_admin"`
→ `"super_admin"`, any other persisted `enterprise` value: audit actions stay as historical rows,
new actions use the new names) in migration `0080_rename_enterprise_admin.sql`; kernel identifiers
(`EnterpriseAdmin` decorator, `EnterpriseAdminLock`, `isEnterpriseAdmin`, `countEnterpriseAdmins`,
`createEnterpriseAdminIfNone`, error codes like `account.last_enterprise_admin`, config keys if any,
the `/me` field); `@capybara-hq/testing` helpers. Tests updated; migration test for the column and
the stored values.

### Task R2: CLI, web code and copy

CLI (`capybara admin …` flags and output), web code (types, loaders, components) and messages: zh
超级管理员 / 平台 / 智能体 / role names, en Super admin / Platform / Org owner… ; `check:i18n` rules
rejecting 企业, 企业管理员 and the Latin word `agent` in zh messages (placeholders excluded), with red
fixtures.

### Task R3: docs, skills and the terms guard

AGENTS.md, `.agents/skills/*` (not the synced ones), README, docs/deploy, docs/config.md (regenerated
if config keys changed), the design spec's live sections; `check:terms` gains the old code-shaped names
(`EnterpriseAdmin`, `isEnterpriseAdmin`, `enterpriseAdmin`, `is_enterprise_admin`, …) with exemptions for
applied migrations, the rename migration and its test, historical specs/plans; changesets for every
published package touched.
