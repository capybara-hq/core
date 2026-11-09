---
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/testing": patch
---

`platform.page` contributions are served to super admins on org-less routes under
`/api/v1/admin/ui/` (`contributions`, `views/:plugin/:id`, `actions/:plugin/:id`,
`embeds/:plugin/:id/token`, `stream`): the extension must be running (no org enablement applies)
and gets the platform's deployment config. `UiRenderArgs` / `UiActionArgs` become unions narrowed
on `scope`: the platform variant has `role: "superAdmin"` and no `orgId`. `EmbedClaims` gain
`scope: "org" | "platform"` (`orgId` absent exactly for the platform scope); a platform token
verifies only for a `platform.page` contribution while the account is still an active super admin,
and an org token never verifies for one. `ctx.ui.invalidate` takes no `orgId` for a `platform.page`
contribution (refreshing the admin console's stream) and throws when one is given.
