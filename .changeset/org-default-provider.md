---
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
---

Kernel: an org chooses the default provider of an `org-default` extension point (`web-search`,
`web-fetch`): table `org_extension_point_defaults` (migration 0064), `ExtensionPointDefaults`
(`resolve`, `list`, `setDefault`) and the routes `GET /api/v1/orgs/:orgId/extension-points`,
`PUT …/extension-points/:point/default` and `GET …/extension-points/available`. Testing: the fake
extensions `fake-web` and `fake-web-2` (scripted `web-search@1` / `web-fetch@1` providers).

Kernel: the `web.*` config section (`web.search.maxResults`, `web.fetch.maxPageChars`,
`web.fetch.maxAnswerTokens`, `web.fetch.cacheSeconds`, all hot), `BuiltinTool.unavailable` may be
async and receives `{ orgId }`, and builtin tools get `parentRunId` in their call context.

Kernel: `WebSearch` and `WebFetch` are builtin tool names (`BUILTIN`, `WEB_TOOL_NAMES`) with the
display kinds `search` / `read`; the Claude Code tool-name map lists both as same-name tools
(new snapshots only) and Claude agent import maps `WebFetch` / `WebSearch` to them.

Kernel: the builtin `WebSearch` tool (default `ask`, read-only, open-world): searches with the
org's default `web-search@1` provider, filters the results again (absolute http(s) URLs, titled,
unique, within `allowed_domains` / `blocked_domains`, at most `web.search.maxResults`) and heads
every result with `Search date: YYYY-MM-DD (UTC).`; provider errors map to fixed texts. Calls to
`web-search@1` and `web-fetch@1` providers are counted in flight and drained on disable / upgrade.
