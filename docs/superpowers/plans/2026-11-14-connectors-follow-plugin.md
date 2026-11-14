# Connectors follow their plugin off and on — implementation plan

**Goal:** switching a plugin off in an org switches off the connectors recorded on its install
(keeping their endpoint and credentials) instead of leaving them enabled; switching the plugin back
on switches back on exactly the connectors the plugin switched off. Deleting a connector stays
possible and permanent; a failed install's rollback keeps deleting what it created.

**Spec:** `docs/superpowers/specs/2026-11-05-plugin-component-management-design.md` §5 rule 8 (as
amended 2026-11-14), P2-6, P3-41.

## Decisions

- **Which connectors:** the connector rows in the uninstalled install's ledger
  (`plugin_install_components`, kind `connector`), whether the install created them (`created: true`)
  or took them back through the reuse path (`created: false`). Connectors made from the same
  template but not recorded on the install are not touched. The install row is deleted on
  uninstall, so the ledger cannot carry the marker afterwards.
- **The marker:** a new nullable column `connectors.disabled_by_plugin_id uuid` — the catalog item
  (plugin) whose switch-off disabled the connector. It is the smallest durable marker that answers
  both questions the re-enable needs ("was it the plugin?" and "which one?"), survives the install
  row, is queryable, and costs one add-column migration. A plain boolean would answer the first
  question but not the second (a dependency's connector is re-enabled by the dependency's install,
  and the item id makes that exact). A connector already disabled by hand when the plugin goes off
  is not marked, so a later switch-on leaves it disabled.
- **Re-enable:** the install's existing reuse path (`liveTemplateConnector`) takes the connector
  back and records it `created: false`; it switches the connector on only when
  `disabled_by_plugin_id` is the installing item. An org admin's own status change clears the
  marker (`ConnectorsService.update`, `setStatusAsPlatform`), so a hand-disabled connector stays off.
- **Rollback:** a failed install's rollback (`rollback()`, and uninstall cleanup of a failed or
  stale install) keeps deleting what that install created. The uninstall code treats
  `plugin_install_rollback` / `plugin_upgrade_cleanup` reasons as rollback too, so a dependency
  install removed by a rollback still deletes its connectors.
- **Scope sync:** a scope-sync uninstall (`via: "scope"`, a deployment-level disable or scope
  narrowing) disables its connectors the same way; the old `org_owned` reason goes away.
- **Tools:** the connector registry already hides every tool of a connector whose `status` is not
  `active` (`ToolRegistry.forAgent` pushes `App <slug> is disabled` into `hidden`); the change
  needs no registry code, only a test proving it for a plugin-disabled connector.

## Tasks

1. Migration `0129_connector_plugin_disabled.sql`: `ALTER TABLE connectors ADD COLUMN IF NOT EXISTS
   disabled_by_plugin_id uuid` (expand-only, idempotent); the type in
   `packages/kernel/src/db/kernel-schema.ts`; a migration test.
2. `ConnectorsService`: `disableWithPluginIn` (active → disabled + marker; already disabled → leave
   it and its marker) and `enableIfPluginDisabledIn` (disabled + this plugin's marker → active,
   marker cleared); clear the marker on an explicit status change in `update` /
   `setStatusAsPlatform`.
3. `PluginInstaller.uninstallIn`: before the pre-existing branch, a connector of a normal uninstall
   (not rollback-like) is disabled with the item and reported `kept` / `disabled_with_plugin`;
   remove the scope-sync `org_owned` branch. The rollback-like branch keeps the old removal rules.
4. `PluginInstaller.execute`: when the connector step reuses a live connector, call
   `enableIfPluginDisabledIn` for the installing item before recording it.
5. `PluginInstaller.previewUninstall`: every ledger connector of the install is listed in `kept`
   as `disabled_with_plugin` (and the agents using it are still listed); no connector is reported
   as removed or as `pre_existing`.
6. Web: `KEPT_REASONS` gains `disabled_with_plugin` and loses `org_owned`; the switch-off dialog
   shows a "will be disabled (settings kept)" group and keeps connectors out of "removed"; copy in
   en and zh (zh uses 智能体, never the Latin word `agent`).
7. Tests: switch-off disables the install's connectors and leaves an org-created one alone;
   switch-on re-enables only the plugin-disabled ones; a manually disabled one stays off; a
   disabled connector's tools are not offered; failed-install rollback still removes; the preview
   lists connectors as to-be-disabled; migration column.
8. Changeset (`@capybara-hq/kernel` + `@capybara-hq/capybara`, patch), Conventional Commit, push,
   PR.

## Verification

`pnpm typecheck`, `pnpm lint`, `pnpm check`, the kernel catalog/schedules/tools/channels suites and
the web catalog tests; every behavioural change is proven red first where practical.
