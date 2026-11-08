---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

One name: devices. Environments become devices everywhere in the kernel: migration 0095 renames the
tables (`devices`, `device_instances`, `device_defaults`, `device_machines`), the `device_id` columns,
indexes and constraints, turns `source` `device` into `local`, the provider `@device` into `@local`
and the log event `environment_paths` into `device_paths`. Config `environments.*` becomes
`devices.maxPersonal` and `devices.local.*` (`CAPYBARA_DEVICES__…`); error codes `environment.*`
become `device.*` and the sign-in codes become `device_sign_in.*`; routes move to
`orgs/:orgId/devices…`, Platform operations to `devices.*`, the IM command to `/device`, sandbox
file systems to `cap-device-<id>` (existing cloud files under `cap-env-<id>` are left behind) and
the sign-in `verificationUri` to `<web>/devices/link`.
