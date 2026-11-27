---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

Scheduled tasks are renamed to automations in the kernel, with no change in behavior. Migration
0188 renames the tables (`automations`, `automation_runs`, `automation_grants`) and rewrites the
stored values that name the feature. The HTTP API moves to `/api/v1/orgs/:orgId/automations`, the
builtin tools become `AutomationCreate`, `AutomationUpdate`, `AutomationList`,
`AutomationTargets` and `AutomationDelete`, the Platform operations `automations.*`, the error
codes and audit actions `automation.*`, the roles `automations.use` / `automations.manage`, the
org settings group `automations`, the push category `automations` and the inbox kind
`automation_attention`. The kernel config group `schedules.*` becomes `automations.*`: a
deployment that sets `CAPYBARA_SCHEDULES__*` must rename those variables to
`CAPYBARA_AUTOMATIONS__*`, and rename the `schedules` group in its config file and in Nacos too:
the kernel refuses to start while the old key is present. Stop old replicas before migrating
(0188 cannot run beside them); `sched-fire` and `sched-settle` jobs already in Redis are dropped
and the next scan tick recovers them. See the upgrade guide.
