# Org egress ceiling Implementation Plan

> **For agentic workers:** executed natively in one session plus one web subagent; a final
> independent review on the most capable model covers the whole branch (trust boundary).

**Goal:** An org's sandbox network is a delta that follows the platform, and the super admin can make
the platform allowlist a ceiling.

**Architecture:** The derivation lives only in `sandbox/modes.ts` (`orgEffectiveHosts`,
`orgCloudMode`, `orgHostOutsideCeiling`, `coversHost`). Settings, requests, devices, the network-ask
notes and scheduled-task grants all call it. The org settings schema stores the delta, and
migration 0134 converts stored copies without widening any org.

**Spec:** `docs/superpowers/specs/2026-11-15-org-egress-ceiling-design.md`

## Global Constraints

- No compatibility layer for `allowHosts`. An invalid stored value reads as
  `{ mode: "allowlist", base: "none" }`.
- Applied migrations are immutable. 0134 is new and idempotent.
- Writes happen under the org lock, in `@Transactional`. An approval goes through
  `OrgSettingsService.update`.
- Model-visible notes are English. UI text uses zh and en (平台 / 超级管理员).

## Review Focus

1. Under `within`, stored values sent back unchanged (`open`, extras outside the ceiling) must not
   block an approval or a save.
2. A token must not store a widening that is hidden by the kill switch or `within`.
3. Migration 0134 must handle odd stored shapes (a non-array `allowHosts`, non-string elements,
   duplicates).
4. The web must send the stored value whole (`mode`, `base`, stale exclusions).
5. A platform change must reach an org after an approval.

---

### Task 1: Derivation (`sandbox/modes.ts`), schema and config

- Unit `modes.test.ts`, written red first: delta, `base: none`, kill switch, `within` filtering
  (including `*.a.d` under `*.d`, and not `*.d` under `d`), forced allowlist.
- `CloudNetworkSettingSchema` takes the delta shape. Add `sandbox.limits.orgHosts`
  (`extend` | `within`, default `extend`). `covers` moves to `coversHost`.

### Task 2: `OrgSettingsService`, controller, Platform ops

- `deployment()` returns `{ allowHosts, orgHosts, off }`. Add `effectiveNetwork()`; GET and PATCH
  and both ops return it.
- `assertWithinCeiling(before, patch)` runs under the lock and in the op precheck.
  `cloudNetworkWidens` compares stored deltas.
- Tests: `orgs/settings.test.ts`, `platform/ops-channels-settings.test.ts`,
  `tools/registry.test.ts`.

### Task 3: Requests, devices, notes, grants, warning

- `approveNetwork` writes only the delta (a re-admitted exclusion or an extra) and never `mode`.
  Under `within`, a host outside the ceiling refuses the whole request, both when filing and when
  approving.
- The devices view `source` reads the delta.
- `planNetworkAsk` and `networkGrantRefusal` take `outsideCeiling` and use the super-admin wording.
- `sandboxConfigWarnings` warns when `within` is set without `devices.autoMode: off`.
- Tests: `catalog/network-requests.http.test.ts` (platform change after approval; `within` cases),
  `tools/network-asks.unit.test.ts`, `tools/sandbox/run-budget.test.ts`, plus the fixtures listed in
  spec §3.

### Task 4: Migration 0134

- `test/migrations/0134.test.ts`: list, empty list, open mode, odd shapes, idempotent.

### Task 5: Web (subagent)

- `lib/org-settings.ts`, `settings/sandbox/view.tsx`, `NetworkFacts.tsx`, i18n, and tests per spec
  D4.

### Task 6: Docs and release

- Auto mode spec §4.3 / §4.4, the `writing-sandbox-providers` and `writing-kernel-api` skills,
  `docs/config.md` (generated), `docs/deploy/upgrade.md`, and the changeset.
- `pnpm verify`, then an independent Opus review of the branch, PR, CI, merge.
