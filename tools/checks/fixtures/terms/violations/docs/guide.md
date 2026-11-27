# Guide

Plugin schemas stay `plugin_<name>`.
Set `CAPYBARA_PLUGIN_CONFIG__OBJECT_STORE_S3__BUCKET` to choose the bucket.
Review requests at /admin/directory/requests.
Org admins open /settings/apps.
Tests call `assertPluginSecretsReachable(manifest)`.
Bundles are described in `writing-apps`.
Bundles list their plugins in `app.yaml`.
The package.json section sets `capybara.kind` to "plugin".
Call `parseAppManifest(text)` on the bundle.
Each entry has one of `PACKAGE_KINDS`.
Read the old index with `parseCatalogIndex(json)`.
It returns a `CatalogIndex`.
Tests build a bundle with `appBundleTgz()`.
The agent can call `sandbox_bash` and `skill_load(` in a prompt.
The `tool_search` result is archived by `read_tool_output`.
Only accounts with `isEnterpriseAdmin` may call it.
The `EnterpriseAdminLock` provider serializes `countEnterpriseAdmins()`.
The column `is_enterprise_admin` and the error `account.last_enterprise_admin` are gone.
The decorator lives in `identity/enterprise-admin.ts`.
The table `scheduled_tasks` keeps `scheduled_task_runs`, and the tool `ScheduleCreate` lists them.
Set `CAPYBARA_SCHEDULES__MAX_TASKS_PER_ORG` and read `schedule_attention` in the inbox.
The org setting `scheduledTasks.forbiddenToolsUnreadable` is read by `ScheduledTaskStore`.
The index `scheduled_tasks_org_idx` is renamed with its table.
The run row keeps `scheduledTaskId` and a `scheduledTaskRuns` list.
The jobs `sched-fire` and `sched-settle` run under the roles `schedules.use` and `schedules.manage`.
The copy lives under `scheduleSettings.title` and `inboxSchedule.label`.
