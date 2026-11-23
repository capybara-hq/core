---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/testing": patch
---

The kernel drops the org-only extension config: an org's config of an extension is its copy of the
overridable deployment fields. `PUT /orgs/:orgId/extensions/:extension` takes `{ enabled, force,
confirm }` only, the org extension view loses `config`, `secrets` and `orgConfigSchema`
(`configurable` now means "has an overridable field", `needsConfig` comes from the effective config
alone), the install body loses `extensionConfig`, `extension.no_org_config` and the
`extensions.set-org-config` operation are gone, and point providers, directory sync, web tools and
setup checks get the org's effective config only. Deployment fields are org-overridable by default
(`platformOnly` marks the rest). The testing fixtures move their org fields into `deployment`
(fake-web's `token`, fake-im's `directoryUrl`) and mark the fixtures of points without org config
platform-only. `plugins.set-enabled` switches a plugin on whose
extension still needs the org's config (as the web does) and says so in `configNeeded`. A
`platformOnly` mark below a top-level key (a hand-made package) makes that whole key platform-only,
and a pipe or transform deployment root is read through to its input object.

A config field's meta is merged across its default / optional / nullable / prefault / catch /
readonly wrappers, and `secret` counts on any of them: a mark on a wrapper
(`platformOnly(secret(x).optional())`) no longer hides the secret below it, which made the load
fail as an unreachable secret.
