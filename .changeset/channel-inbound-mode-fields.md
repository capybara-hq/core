---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
"@capybara-hq/capybara": patch
---

Channel connections choose their inbound mode when they are created. The config UI hint
`inboundModes` (connection level, top-level fields) ties a field to inbound modes: forms draw it
only in those modes and require it there, and the kernel refuses a create, config change or mode
switch that leaves a required field empty (`extension.config_invalid`). `inboundModeFields` and
`missingInboundModeFields` read the hint. `POST /channels` takes `inboundMode`;
`GET /channels/schema/:plugin` says whether webhook inbound is usable (`inbound`). A connection name
nobody typed yet is reported unresolved as `no_name`. The fake-im fixture's `webhookToken` is
webhook-only. 新建渠道 sends the guide's mode, follows it with the credential fields, and shows
less noise before save.
