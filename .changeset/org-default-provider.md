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

Kernel: the builtin `WebFetch` tool (default `ask`, read-only, open-world): checks the URL
(absolute https after upgrading `http`, no credentials, at most 2000 characters, a public host,
also for the provider's final URL), fetches the page with the org's default `web-fetch@1`
provider through a Redis page cache (`cache:web_page:<orgId>:<provider>:<sha256(url)>`, TTL
`web.fetch.cacheSeconds`), returns the new URL for a redirect to another host, and cuts pages to
`web.fetch.maxPageChars` with a `[truncated]` marker.

Kernel: `WebFetch` answers the prompt from the page with one call on the new kernel model purpose
`web_fetch` (label "Web page extraction"; unmapped, the calling conversation's model, a
sub-agent's for a sub-agent's call): a fixed system prompt (`WEB_FETCH_SYSTEM_PROMPT`), no tools,
output capped at `web.fetch.maxAnswerTokens`. The result is the answer headed by the URL, never the
page; a failure is a tool error and a `model.request` policy denial is the tool error "An org
policy blocked reading this page; continue without it or ask the user." with its `hook.denied`
audit row and `hook_denied` event. The call fires `model.request` / `model.response` with
`purpose: "web_fetch"` and logs a `usage` event with `purpose: "web_fetch"` and the call's
`callId` (reported through `usage.report`, counted on a sub-agent's parent run). `StepLog` has a
module of its own (`StepLogModule`) and builtin tools get the run's hook scope in their call
context.
