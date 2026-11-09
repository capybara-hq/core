---
"@capybara-hq/kernel": minor
---

The permission review covers client code: `permissions.client` and `ui.component:<id>` are new
permission keys (`PermissionSet.permissions.client`, `permissions.ui.components`), both sensitive
(reasons `client_code` and `ui_component`, a new `client` group) and blocking until the super admin
approves; `capybara extensions review` / `approve` mark them `(sensitive)`. Only `ui.view:*` stays
non-blocking. An upgrade that changes only the client bundle adds no key; older snapshots without
the fields read as no client code.
