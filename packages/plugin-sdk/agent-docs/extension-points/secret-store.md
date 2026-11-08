# Authoring: extension point secret-store

<!-- generated:extension-point -->
- Name: `secret-store` (a ref is `secret-store@<major>`)
- Stores and resolves secrets (connector credentials, secret config) outside the database.
- Providers: one at a time
- Enabled per org: no
- Brokered by the platform: yes (extensions use it only through `ctx`)
<!-- /generated -->

Contract: (kernel-defined; no public SDK contract yet)

Brokered: extensions never call it directly. They use `ctx.secrets` and `secret()` config fields, and results never contain secret values.

See `extensions` for the rules every extension follows.
