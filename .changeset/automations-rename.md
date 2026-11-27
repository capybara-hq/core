---
"@capybara-hq/capybara": patch
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
`CAPYBARA_AUTOMATIONS__*`.
