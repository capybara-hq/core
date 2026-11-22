---
"@capybara-hq/kernel": patch
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

An org's default theme can now shape the agent avatar choices: it may hide built-in presets and add presets of its own. The kernel lists them in `GET /orgs/:orgId/themes` (`avatars`), accepts a theme preset key on create and update (stored pinned to the theme version, `agent.avatar_unavailable` when the org does not offer it), and draws the random default from the visible choices. `AvatarPicker` gains `hidden` and `extra`, and the web create form, template flow and basics section follow the org's choices.
