# Authoring: extension point identity-source

<!-- generated:extension-point -->
- Name: `identity-source` (a ref is `identity-source@<major>`)
- Signs people in through an external identity provider (SSO).
- Providers: several
- Enabled per org: no
- Brokered by the platform: no
<!-- /generated -->

Contract: IdentitySource (`identity.ts`)

Provide SSO login through an external provider. The kernel owns state, nonce and PKCE checks; identities are keyed `<plugin>:<tenant>`.

Declare `tenant` so the admin console can label and check trusted tenants; list tenants that must never be trusted in `neverTrusted` (`validateTenantId` applies the same rule). A super admin turns the source on, orders the login page and sets its trusted tenants in the admin console (the login section of the extension's page, or the `login-sources.*` Platform operations); there is no startup config for it.

See `extensions` for the rules every extension follows.
