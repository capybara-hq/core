---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": patch
---

The deployment-level role "enterprise admin" is now "super admin" (breaking, no compatibility
aliases). Migration `0079_rename_enterprise_admin.sql` renames `accounts.is_enterprise_admin` to
`is_super_admin` and the stored deployment setting `orgCreation: "enterprise_admin"` to
`"super_admin"`; historical audit rows are not rewritten. API: the account field
`isEnterpriseAdmin` is `isSuperAdmin` (`GET /api/v1/me`, the admin account list and
`PATCH /api/v1/admin/accounts/:id`), account creation takes `superAdmin`, `orgCreation` accepts
`"anyone" | "super_admin"`, and the error code `account.last_enterprise_admin` is
`account.last_super_admin`. Kernel exports: the `SuperAdmin` route decorator, `SuperAdminLock` /
`SuperAdminLockModule`, `AccountsService.countSuperAdmins` / `createSuperAdmin` /
`createSuperAdminIfNone` / `setSuperAdminByLogin`, `authorizeSuperAdmin`.

Deploying: migration 0079 renames a column, so replace all replicas at once; a rolling upgrade
across this version breaks the replicas still running the old code.
