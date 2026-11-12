# Skills Default-On Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development with the
> wave-planned-subagent-development layer. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every skill on in an org is on for every agent unless the agent turns it off
(`disabledSkills`), skill pinning is gone, and the catalog listing has a recorded budget.

**Spec:** `docs/superpowers/specs/2026-11-12-skills-default-on-design.md` (read it first; section
numbers below are the spec's). Pattern to copy: the tools default-on change
(`2026-11-08-tools-default-on-design.md`, migration `0092_tools_default_on.sql`, `disabledTools`).

**Branches (stacked PRs, each `Refs #182`):**

| Phase | Branch | Base | Content |
|---|---|---|---|
| docs | `docs/skills-default-on` | `main` | spec + this plan (PR #183) |
| 0 | `test/skills-pinned-fixture` | `docs/skills-default-on` | the recorded pre-change fixture (Task 0) |
| 1 | `feat/skills-default-on` | `test/skills-pinned-fixture` | Tasks 1–8 |
| 2 | `feat/skills-catalog-budget` | `feat/skills-default-on` | Task 9 |

## Global constraints

- AGENTS.md applies. Read the skills named per task before changing that area.
- Migration: `packages/kernel/src/migrations/0116_skills_default_on.sql` (0114 / 0115 belong to the
  parallel network ask line; recheck `origin/main` and that line before pushing and renumber if
  needed). Plain SQL, `IF EXISTS` style, idempotent; it rewrites JSON definitions only.
- Pre-0.1.0: no compatibility layer for API input (`skills.orgSkills` / `skills.pinned` refused),
  but history (logs, eval snapshots, stored packages and templates) keeps parsing.
- Replay: run `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts
  packages/kernel/test/tools/rename-compat.test.ts` before Task 1 and after Tasks 3 and 9.
- Model-visible text is English and the pinned rendering texts in `runtime/context/skills.ts` never
  change (old reconstructions depend on them).
- UI copy through i18n zh + en; zh says 智能体, never the Latin word.
- SDK API change: `pnpm gen:sdk-api` and a changeset bumping `@capybara-hq/plugin-sdk`; kernel and
  web changes: a changeset on `@capybara-hq/capybara`.
- Run single tests from the repo root: `pnpm exec vitest run <path>`.
- Parallel implementers stage only their own paths (`git add <paths>`), never `-A` / `-a`, and fix
  type errors only in files they own (others are in flight).

## Wave plan

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 0 Recorded fixture | — | `packages/kernel/test/evals/fixtures/pre-skills-default-on/`, a new test file | normal | P0 | alone (mid) |
| 1 Definition, migration, resolver | 0 | `agents/definition.ts`, `agents/agents.service.ts`, `migrations/0116_*`, `skills/usable.ts`, `skills/catalog.ts`, `skills/skills.service.ts`, `skills/agent-skills.service.ts`, `catalog/component-state.ts`, `conversations/events.ts`, `runtime/run-worker.ts`, `errors.ts`, testing `createAgent` | high | 1 | alone (most capable) |
| 2 Sub-agents and replay | 1 | `runtime/subagents/*`, `evals/reconstruct.ts`, `evals/snapshot.ts` | high | 2 | alone (most capable) |
| 3 Templates (SDK + kernel) | 1 | `plugin-sdk/src/agent-template.ts`, `agents/from-template.ts`, `agents/org-templates.ts`, `agents/templates.ts` | normal | 2 | batch |
| 4 Import and plugin manifest | 1 | `plugin-sdk/src/plugin-manifest.ts`, `plugin-sdk/schemas/plugin.v1.schema.json`, `catalog/**` (except `component-state.ts`), `skills/skills.service.ts` list fields only after Task 1 | normal | 2 | batch |
| 5 Platform ops and admin views | 1 | `platform/ops/*`, `agents/admin-agents.ts` | normal | 2 | batch |
| 6 Web | 1, 3, 4, 5 (API shapes) | `apps/web/**`, `packages/design` only if needed | normal | 3 | alone (mid) |
| 7 Docs and skills | 1–5 | `.agents/skills/{writing-tools,replay-evals,writing-plugins,writing-web-ui}/SKILL.md` | normal | 3 | batch with 6 |
| 8 SDK API report, changesets, full verify | 1–7 | `packages/plugin-sdk/etc/*`, `.changeset/*` | normal | 4 | final review |
| 9 Catalog budget | 8 | `config/schema.ts`, `docs/config.md`, `skills/catalog.ts`, `runtime/context/skills.ts`, `conversations/events.ts`, tests | high (model-visible) | P2 | alone (most capable) |

## Task 0: record the pre-change fixture (phase 0)

Skills: replay-evals.

- [ ] On the current code (before any change), write a throwaway recording test modelled on the
  pinned cases of `packages/kernel/test/evals/reconstruct.test.ts` ("pinned skills, a pinned version
  change mid-conversation, a claude-code skill with the tool map, and a compaction") plus a
  sub-agent whose template pins a skill (see `test/evals/subagents-replay.test.ts`). It captures the
  case snapshot(s) and every provider request (`test/helpers/provider-capture.ts`).
- [ ] Write `fixtures/pre-skills-default-on/conversation.json` and a README with the commit and the
  recipe (pattern: `fixtures/pre-background-subagents/README.md`). Never regenerated.
- [ ] Add a permanent test (`test/evals/pre-skills-default-on.test.ts`) that reconstructs every
  recorded `model_call` with `drift: []` and equal to the recorded request; it passes on the current
  code and must keep passing after phase 1. Delete the throwaway recorder.
- [ ] Zero-drift groups green; commit `test(kernel): record a pinned-skills replay fixture …`.

## Task 1: definition, migration and resolver (spec §3, §4, §5, §8 kernel part)

Skills: writing-tools, writing-migrations, writing-kernel-api, replay-evals.

- [ ] `AgentDefinitionSchema`: remove `skills.orgSkills` / `skills.pinned` (`skills` keeps only
  `writePolicy`, strict); add `disabledSkills: DisabledSkillRef[]` (default `[]`, max 500) with
  `canonicalDisabledSkills`. `normalizeStoredDefinition` drops `skills.orgSkills` / `skills.pinned`.
- [ ] Save checks in `agents.service.ts` (replace `assertOrgSkills` / `assertPinnedSkills`):
  `validation_failed` at `disabledSkills.<i>` for an unknown plugin or name, a no-plugin skill id not
  usable, a builtin plugin or skill, the agent's own or shared skill; unchanged entries are not
  re-checked. Inline template `skills` must be in the agent's effective skills
  (`skill_not_available`). Remove `agent.pinned_invalid` and `PINNED_SKILLS_LIMITS` users.
- [ ] Migration `0116_skills_default_on.sql`: every `agent_versions.definition` loses
  `skills.orgSkills` / `skills.pinned` (drop `skills` when nothing else is left), gains
  `disabledSkills: []`; org-made agent template versions lose `selectedSkills`. Test on old rows.
- [ ] Resolver (`skills/usable.ts`): replace `selectedSkills` by `agentSkills(db, { orgId, agentId,
  disabledSkills })` = own + shared-by-agent + `usableSkillVersions(org)` − off (builtin, own and
  shared never off); `resolveSkills` ranking unchanged. Every reader (`catalog.ts`, `invoke.ts`,
  invocable list, channels inbound) uses it.
- [ ] `skills/catalog.ts`: remove `pinnedCandidates`, `loadPinnedBodies`, `fitPinned`, the retry
  loop and `pinnedFailureText`; snapshots never carry `pinned`. `run-worker.ts` drops the pinned
  failure path. Keep the event schema's optional `pinned` and every pinned rendering function.
- [ ] `catalog/component-state.ts` `definitionRefs`: skills are used only when named (inline
  template `skills`), spec §11. `agent-skills.service.ts` share confirm no longer edits selections.
- [ ] `@capybara-hq/testing` `createAgent`: `disabledSkills`; update the kernel tests that selected
  or pinned skills (`pinned-skills.test.ts`, `pinned-load.test.ts` are deleted or rewritten as
  "nothing pins"; `skills-runtime`, `platform-skills`, `manual-skills`, `claude-superpowers.e2e`, …).
- [ ] New tests: plugin on/off in the org, an org component switch, a builtin skill that cannot be
  turned off, a whole-plugin `"all"` entry covering a skill added by a plugin update, the org's own
  and a shared skill on by default, the first run after the change writes a snapshot without pins and
  the "Pinned skills removed" notice (on the Task 0 fixture's conversation shape).

## Task 2: sub-agents and replay (spec §6.1, §9)

Skills: writing-tools (sub-agents), replay-evals.

- [ ] `runtime/subagents/definition.ts`: the child's frozen definition carries the parent's
  `disabledSkills` plus the template's `disallowedSkills`; an org agent child uses its own. No
  pinned skills: template / inline `skills` resolved against the child's effective skills become the
  preamble line `Before you start, load these skills with Skill: <a>, <b>.`; the others go to
  `subagent_started.warnings`. `general-purpose` gets no line.
- [ ] Follow-ups: `user_message.dispatch.narrowed.disabledSkills` = union of frozen and current;
  the old `skills: { orgSkills, pinned }` still parses.
- [ ] `evals/reconstruct.ts`: `pinned_changed` = non-baseline, not `definition_missing`, and the
  snapshot in effect has pins; `subagentChanged` compares `disabledSkills` and treats a logged child
  definition with pins (raw) as changed. Update the drift-group cases.
- [ ] Zero-drift groups and the Task 0 test green.

## Task 3: agent templates (spec §6.2)

Skills: writing-plugins.

- [ ] SDK `agent-template.ts`: remove `selectedSkills`; add `disallowedSkills` (≤ 64; `<plugin>:<name>`,
  `<plugin>:*`, bare `<name>`); docs table entries; parser tests.
- [ ] `from-template.ts`: `disallowedSkills` → `disabledSkills`; report items `carried` /
  `unavailable` only; no pins. `org-templates.ts`: save writes `disallowedSkills`, not
  `selectedSkills`; stored templates are read with `selectedSkills` dropped. Tests in
  `test/agents/from-template.test.ts`, `org-templates.test.ts`.

## Task 4: import and plugin manifest (spec §8)

Skills: writing-plugins.

- [ ] SDK: remove `skills[].pinned` from `plugin-manifest.ts` and `plugin.v1.schema.json`; the kernel
  strips it from stored manifests before parsing.
- [ ] Remove `pinnedSuggestions` (import confirm, org upload confirm, `withPinned`), stop writing
  `suggest_pinned`, drop `suggestPinned` / `entryBytes` / `tokenEstimate` from skill APIs.
- [ ] Claude translation: `session_start_pin_hint` → `session_start_hook` with the spec's text;
  `sessionStart` kept. Tests in `test/catalog/claude-*.test.ts`.

## Task 5: Platform operations and admin views (spec §11)

Skills: writing-kernel-api (Platform tool).

- [ ] `agents.ops.ts`: `disabledSkills` from the route's shared schema; descriptions updated.
  `platform.ops.ts` `platform.me`: `skills` (names now, with plugin) and `disabledSkills`.
  `skills.list` returns `builtin`. `admin-agents.ts`: off count. Parity test and
  `pnpm check:platform-ops` green.

## Task 6: web (spec §10)

Skills: writing-web-ui.

- [ ] Agent page 技能: the grouped list means on / off (checked by default), group head = whole
  plugin (`"all"`), 内置 group locked, 「本组织」 group rows only, filter kept, summary and hint;
  remove 置顶 and its messages. New-agent form and template editor (`disallowedSkills`) alike.
- [ ] Org 技能 page: plugin filter, "N 个智能体关闭了它" on the detail page. Org 插件 page switch-off
  confirmation names the skill count. Import page: no pinned suggestions; the new report item.
- [ ] Tests (`agent-skills.test.tsx`, `agent-template-page.test.tsx`, `agent-from-template`,
  `pages`, `messages-parity`), `/dev/ui` catalog blocks; reference and visual PNGs only from the
  `reference-update` / `visual-update` workflows, then an empty commit so CI runs.

## Task 7: docs and skills

- [ ] Update `writing-tools` (Skill tools, pinned bullet), `replay-evals` (pinned in old logs, the new
  `pinned_changed`), `writing-plugins` (import, template fields, `plugin.json`), `writing-web-ui` if it
  names the section.

## Task 8: SDK report, changesets, verify

- [ ] `pnpm gen:sdk-api`, changesets, `pnpm lint && pnpm typecheck && pnpm check && pnpm verify`.

## Task 9: catalog budget (phase 2, spec §7)

Skills: adding-config, replay-evals.

- [ ] Config `skills.catalogBudgetChars` (hot, default 16000; regenerate `docs/config.md`).
- [ ] Snapshot entries gain optional `nameOnly`; at snapshot time rank (own, builtin, org's own,
  plugin; by name) and keep descriptions while the rendered lines fit; log
  `skills.catalog_over_budget`.
- [ ] Rendering: entries with descriptions as today, then `More skills (names only; call Skill with
  the name to read one):` and the names; `sameSkills` compares `nameOnly`; old snapshots render
  byte for byte. Zero-drift cases: an old snapshot, a budget change between runs.

## Review focus

- Old logs with pins reconstruct byte for byte (Task 0 test) and the first new run says the pins
  were removed.
- A whole-plugin off entry hides skills the plugin adds later; a builtin skill can never be off.
- A follow-up child can lose skills but never gain them.
- The migration leaves `writePolicy` and touches only definitions and org-made templates.
