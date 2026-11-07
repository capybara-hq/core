---
"@capybara-hq/plugin-sdk": minor
---

Add `orgAccess(schema, "readonly" | "override")` and `orgAccessOf`: a deployment config field can allow an org to override it per call. `configJsonSchema` publishes the level as `x-org`, and `validateConfigUi` refuses `x-org` outside top-level deployment fields and on secrets marked `readonly`.

Every call the kernel makes for an org carries the extension's effective deployment config for that org as `config` (optional in the types, so older extensions compile): `web-search@1` / `web-fetch@1` `search` / `fetch` args and `configured(orgConfig, config)`, `directory@1` `listMembers` args and `configured(orgConfig, config)`, `ToolCallContext`, `UiRenderArgs` (and so `UiActionArgs`), `FilePreviewArgs`, and a third hook handler parameter `call: HookCall` (`{ config }`).
