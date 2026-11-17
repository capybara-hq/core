---
"@capybara-hq/plugin-sdk": minor
---

`ctx.net.fetch` (`ExtensionNet`): the kernel's guarded HTTP client for URLs a person supplied
(connector endpoints, org-overridable base URLs): https only, private / loopback / link-local
addresses refused unless a super admin allowed the internal endpoint for the org (`opts.orgId`),
redirects never followed. A refusal is a `NetDeniedError` (`code`, `host`, and `status` for a
refused redirect); detect it with `isNetDeniedError`, never `instanceof`.
`ConnectorOpenArgs.orgId` and `orgId` in the `Connector.inspect` args (both required) are the org
the session or preview serves.
Plugin authors: `ctx.net` needs a kernel that ships it; a plugin that calls it raises its
manifest's minimum `sdk` to this release.
