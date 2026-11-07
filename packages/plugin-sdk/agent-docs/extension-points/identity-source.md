# Extension point: identity-source

<!-- generated:extension-point -->
- Name: `identity-source` (a ref is `identity-source@<major>`)
- Signs people in through an external identity provider (SSO).
- Providers: several
- Enabled per org: no
- Brokered by the platform: no
<!-- /generated -->

Contract: IdentitySource (`identity.ts`)

Provide SSO login through an external provider. The kernel owns state, nonce and PKCE checks; identities are keyed `<plugin>:<tenant>`.

See `extensions` for the rules every extension follows.
