# Web tools: `WebSearch`, `WebFetch` and their provider extension points

- Date: 2026-11-04, written against `main` at `ce888944` (tool naming aligned with Claude Code, #56,
  merged).
- Status: implemented (see "As built" at the end).
- Markers: **(decided)** is the maintainer's answer during brainstorming (2026-11-04);
  **(designer's call)** is decided here on the maintainer's behalf and may be overturned in review.
  Items without a marker restate current code or AGENTS.md rules.
- Written in English (AGENTS.md "Language"). Model-facing text quoted here is the proposed wording;
  the builder may polish it, but it stays English and passes the `pnpm check` tool-design rules.

## 1. Why

Agents answer from their training data. Two jobs need the live web:

1. Information that is not in the model's training data at all.
2. Checking whether something the model "knows" is out of date, or finding the newer version of it.

Both need the same pair of abilities: **find** candidate pages, then **read** a page's actual text,
so the answer can be checked and cite its sources. Capybara has no web access today: an agent can
only reach the web through a connector someone set up, or through `Bash` in a sandbox with open
egress.

The first provider is [Jina](https://jina.ai) (`s.jina.ai` search, `r.jina.ai` reader). Each org
uses its own Jina token and pays for its own usage **(decided)**.

## 2. Goals, non-goals, anti-goals

Goals:

- Two kernel builtin tools, `WebSearch` and `WebFetch`, with Claude Code's names, parameters and
  behavior **(decided)**, so skills, commands and agents written for Claude Code that name them work
  unchanged.
- Two extension points, `web-search@1` and `web-fetch@1` **(decided)**: the kernel owns the tools,
  extensions only implement the backend. Changing provider never changes what the model sees.
- Per-org provider configuration (the Jina token is an org-level `secret()` field) **(decided)**.
- A **general** "org default provider" mechanism for `multi` extension points, so an org that has
  enabled two providers of one point picks which one the tool uses **(decided)**.
- Default policy `ask` for both tools, with the existing approval scopes: once, this conversation
  (`session`), always **(decided)**.
- The `jina` plugin in `capybara-hq/plugins`, providing both points.

Non-goals:

- Anthropic's server-side `web_search` / `web_fetch` tools. They run inside one provider's model call,
  bypass the kernel tool pipeline (policy, hooks, archiving, the event log) and bill the deployment's
  model account, not the org's provider. Not supported and not planned here.
- Crawling, multi-page fetches, screenshots, PDFs-as-images, JavaScript interaction.
- A deployment-wide (non-org) provider. The points are org-scoped; a deployment that wants one
  shared token enables the plugin in each org with the same config.

Anti-goals (would make this a failure even if it works):

- The model sees provider-specific tool names or parameters (`plugin__jina__search`). The whole
  point is one stable `WebSearch` / `WebFetch`.
- A provider is chosen silently when the org has several and picked none.
- A fetched page's raw text reaches the main model's context (`WebFetch` returns the extraction
  only, as in Claude Code).
- A replay re-fetches or re-extracts anything.

## 3. What the model sees

### 3.1 `WebSearch`

Parameters, as in Claude Code:

| Field | Type | Notes |
|---|---|---|
| `query` | string, minLength 2 | required |
| `allowed_domains` | string[] | optional; only results from these domains |
| `blocked_domains` | string[] | optional; never results from these domains |

Sending both lists is a validation error **(designer's call**, matches the Claude API's rule; a
`oneOf` in the schema or a `ToolError` naming both fields). Domain entries are hostnames
(lowercased, no scheme or path); a subdomain is covered by its parent.

Result `content` (one text block): a numbered list, one entry per result: title, URL, published date
when the provider has one, and the snippet; followed by the line
`Cite the sources you use as markdown links in your answer.` (Claude Code tells the model to list
sources; the exact sentence is the builder's). At most 10 results **(designer's call)**.

Description (proposed):

> Search the web and get a list of results with title, URL and a short snippet. Use it for
> information newer than your training data, or to check whether something you know is still
> current. Then use WebFetch to read the pages you need. Do not use it for questions you can answer
> reliably without the web. Cite the sources you use.

The description is fixed text with **no date** **(designer's call**, revised after the builder
check). Claude Code puts today's date in the description, but here that would break two things:
`specHash` is the hash of the whole spec (`tools/registry.ts`), `tool_specs` keeps the first text
stored per hash and replay rebuilds requests from it, so a dated description either changes the hash
every day (remembered grants expire at midnight) or makes the log lie about what was sent. Instead
the result's first line is `Search date: YYYY-MM-DD (UTC).`: it is part of the recorded
`tool_result`, so it needs no `DriftReason`, and from the first search on the model knows the date
when it refines a query.

### 3.2 `WebFetch`

Parameters, as in Claude Code:

| Field | Type | Notes |
|---|---|---|
| `url` | string, format uri | required; `http` is upgraded to `https` |
| `prompt` | string, minLength 1 | required; what to extract from the page |

Behavior **(decided: copy Claude Code)**:

1. Validate the URL (§7.1), upgrade `http` to `https`.
2. Ask the org's `web-fetch@1` provider for the page as markdown (§4.2).
3. If the provider reports a redirect to **a different host**, do not extract: return
   `The URL redirected to <final URL>. Call WebFetch again with that URL if you want its content.`
   (Claude Code's behavior; the final URL is validated like any other before the model can use it.)
4. Run one extraction model call (§5): the page markdown plus `prompt` in, a short answer out.
5. Return the answer as the tool result, headed by the fetched URL (and the final URL when it
   differs only by path).

Description (proposed):

> Fetch a web page and answer a question about it. Pass the full URL and a prompt saying what to
> extract; the page is read and a smaller model answers the prompt from it, so the result is the
> answer, not the raw page. Use it after WebSearch, or when the user gives you a URL. It is
> read-only. HTTP URLs are upgraded to HTTPS. If the URL redirects to another host, the result tells
> you the new URL to fetch.

### 3.3 Policy, approval, display

- `defaultPolicy: "ask"` for both **(decided)**, with `annotations.readOnlyHint: true`,
  `openWorldHint: true`. The approval card offers the existing scopes `once`, `session` (this
  conversation) and `always` (this account + agent + tool). Agent `toolPolicies` and org defaults
  can tighten or loosen as for any builtin. Neither tool is on `R3_FIXED_ASK_TOOL_KEYS`.
- Because the spec is owned by core and fixed, switching provider does not change `specHash`, so
  remembered grants survive a provider change.
- `keyArgs`: `WebSearch` `query`; `WebFetch` `url`, `prompt`.
- `ToolKind`: `WebSearch` -> `search`; `WebFetch` -> `read` **(designer's call)**; the web adds
  localized verbs (zh / en) as for the other builtins. `display.summary` e.g.
  "Searched the web: <query> (8 results)" / "Read <host>".
- Sub-agents may use both tools **(designer's call)**; their approvals go to the person who
  started the parent run, as today.

### 3.4 Availability

- Both names join `BUILTIN` / `BUILTIN_TOOL_NAMES` (`tools/builtin-names.ts`) and the web's copy
  (`apps/web/src/lib/agents.ts`, `lib/timeline.ts`; `test/tools/builtin-names.test.ts`).
- An agent opts in with builtin refs `{kind:"builtin", name:"WebSearch"}` /
  `{kind:"builtin", name:"WebFetch"}`, selectable in the agent form **(designer's call**: not
  given to every agent automatically; the agent form shows them only when the org has a provider).
- `BuiltinTool.unavailable` is synchronous and takes no arguments today; it becomes
  `(ctx: { orgId, signal }) => Promise<string | null>` (or the web tools get their own async check in
  `ToolRegistry.forAgent`; builder's choice), because resolution reads PG and decrypts org config.
  The agent form learns which builtins the org can use from a new field on the existing builtin
  list API (`available: boolean`, `unavailableReason`), so it can show the web tools only when a
  provider resolves.
- At each step the registry resolves the org's provider for the point (§6). No provider ->
  the tool is unavailable with the standard reminder, reason
  `no web search provider is enabled in this org; ask an org admin to enable one` (or
  `… several are enabled and none is set as the default; ask an org admin to choose one in the org
  settings`). The run does not fail.

## 4. The extension points (SDK)

Both are registered in `EXTENSION_POINTS` as `multi`, **brokered**, `orgScoped`, with the new
`selection: "org-default"` (§6). Brokered **(designer's call**, after the builder check): only the
kernel consumes them, because every call needs the org's decrypted `orgConfig`, which another
extension cannot have; an extension that wants web results uses the tools through an agent. They follow `directory@1`: the kernel passes the org's decrypted
`orgConfig` to every call, so an extension needs no new `ctx` API to read its org's token.

### 4.1 `web-search@1`

```ts
export const WEB_SEARCH_EXTENSION_POINT = "web-search@1";

export interface WebSearchProvider {
  /** Optional: false when this org's config lacks what the provider needs (like Directory.configured). */
  configured?(orgConfig: unknown): boolean;
  search(args: {
    query: string;
    allowedDomains?: string[];   // hints; the kernel filters the results again (§7.2)
    blockedDomains?: string[];
    maxResults: number;          // the kernel asks for 10
    orgConfig: unknown;
    signal: AbortSignal;
  }): Promise<{ results: WebSearchResult[] }>;
}

export interface WebSearchResult {
  title: string;
  url: string;          // absolute https/http URL
  snippet?: string;     // plain text or markdown, provider-trimmed
  publishedAt?: string; // ISO 8601 date or datetime, when known
}
```

### 4.2 `web-fetch@1`

```ts
export const WEB_FETCH_EXTENSION_POINT = "web-fetch@1";

export interface WebFetchProvider {
  configured?(orgConfig: unknown): boolean;
  fetch(args: {
    url: string;          // already validated and upgraded by the kernel
    orgConfig: unknown;
    signal: AbortSignal;
  }): Promise<{
    finalUrl: string;     // after redirects; equal to url when none
    title?: string;
    markdown: string;     // the page as markdown
    contentType?: string;
  }>;
}
```

Errors: both throw `WebProviderError(message, { kind })` (new SDK class), `kind` one of
`not_found` (404 / no content), `blocked` (the site refused the provider), `auth` (bad token),
`rate_limited`, `unavailable` (provider down / 5xx / timeout), `invalid` (the provider rejected the
query or URL). The kernel maps each to a fixed English, actionable `ToolError` text **(designer's
call**: providers never write model-visible text; e.g. `auth` -> "The web search provider rejected
its credentials; ask an org admin to check the provider's configuration.", `rate_limited` -> "The web
search provider is rate limiting this org; retry in a minute or continue without it."). Any other
exception is the pipeline's generic failure.

Limits: the kernel caps `markdown` at `web.fetch.maxPageChars` (default 400 000) before extraction
and caps the extraction input at the purpose model's context minus headroom (§5); results over the
cap are cut with a `[truncated]` marker visible to the extraction model only.

The SDK changes regenerate `api/plugin-sdk.api.md` and need a changeset bumping
`@capybara-hq/plugin-sdk` (`check:sdk-api`, `check:sdk-api-changeset`).

## 5. `WebFetch` extraction

- A new kernel model purpose `web_fetch` in `KERNEL_PURPOSES` (`models/purposes.ts`), label
  `{ zh: "网页提取", en: "Web page extraction" }`. Deployment default and org override as for every
  purpose; **unmapped -> the conversation's current chat model** (as `title` does) **(designer's
  call)**.
- One non-streaming-to-the-user call: a fixed system prompt (core constant, English) plus one user
  message carrying the page (URL, title, markdown) and the `prompt`. The system prompt follows Claude
  Code's: answer only from the page; say so when the page does not contain the answer; keep quotes
  short (no more than about 125 characters each), never reproduce long passages or song lyrics; be
  concise.
- No tools, no thinking beyond the model's minimum, output cap `web.fetch.maxAnswerTokens`
  (default 4 000) **(designer's call)**.
- "The conversation's current chat model" means the model of the conversation that made the call:
  a sub-agent's call uses the sub-agent's model **(designer's call)**.
- Its tokens are written as a `usage` event with purpose `web_fetch` and the `callId`, counted
  against the org. When a sub-agent makes the call they also count toward the parent's
  `subagent_tokens_used` (`subagents.maxTokensPerRun`), like the child's own model calls; a
  top-level run has no token cap today and gets none here **(designer's call)**.
- The SDK's closed unions `ModelCallPurpose` / `UsagePurpose` (`plugin-sdk/src/hooks.ts`) gain
  `"web_fetch"`, so `usage.report` and the model hooks see it (part of the SDK change in §4).
- The extraction request fires `model.request` / `model.response` hooks like the `title` call does
  (`observeTitle`) **(designer's call)**: page content entering a model is exactly what a DLP policy
  hook wants to see. A policy hook's denial (or fail-closed) becomes the tool error
  "An org policy blocked reading this page; continue without it or ask the user." and is logged as
  for any hook denial (`hook.denied`, `hook_denied`).
- Model errors follow the kernel's degradation ladder; a failure becomes the tool error
  "Could not extract an answer from the page; retry, or try another URL." The fetched page is not
  returned instead (anti-goal).
- The raw page is **not** stored **(designer's call**, revised after the builder check): today
  `tool_outputs` is readable by any `ReadToolOutput` in the conversation and the trajectory viewer
  does not read it, so "kept for debugging, hidden from the model" would be a new storage path with
  its own privacy review. Debugging uses the recorded URL and answer plus the provider's own logs; a
  later spec can add page copies if they turn out to be needed.

## 6. Org default provider (general mechanism)

Today an extension point is `single` (one provider per deployment) or `multi` (several, the
consumer decides). Nothing lets an org say "use this one".

- `ExtensionPointInfo` gains `selection?: "org-default"`; allowed only with `multi` + `orgScoped`.
  `web-search` and `web-fetch` set it; existing points don't.
- New table `capybara.org_extension_point_defaults (org_id, point, extension, updated_at, updated_by)`,
  primary key `(org_id, point)` (`point` is the name without the major, e.g. `web-search`).
- Resolution, per call, never cached in process:
  1. the org's enabled providers of the point (the enabled-set query of `extensions/enabled.ts`),
     filtered by `configured(orgConfig)` when the provider has it;
  2. exactly one -> it;
  3. several -> the stored default if it is among them, else **none** (tool unavailable, reason
     above);
  4. zero -> none.
- API: `GET /api/v1/orgs/:orgId/extension-points` (each `selection` point with its candidate
  providers and the current default) and `PUT /api/v1/orgs/:orgId/extension-points/:point/default`
  `{ extension }` (permission `org.extensions.manage`; 400 `validation_failed` if the extension does
  not provide the point or is not enabled in the org). Audit row `extension_point.default_set`.
- A stored default that is disabled or uninstalled is left in place and simply ignored by rule 3;
  enabling it again restores it.
- Web: the org's extension settings page shows a "Default provider" select per such point
  (design-system components only, i18n zh / en).

## 7. Safety

### 7.1 URL rules (`WebFetch`)

- `https` only after the upgrade; no credentials in the URL; at most 2 000 characters (Claude Code's
  limit).
- Reject hosts that are IP literals in private, loopback, link-local or reserved ranges, and
  single-label / `localhost` names, before calling the provider, and again for `finalUrl`
  **(designer's call)**. Jina fetches from its own network, so this matters for providers that fetch
  from inside the deployment; the `web-fetch@1` contract says such a provider must also refuse
  private addresses after DNS resolution (it may reuse the kernel's rules by importing a pure SDK
  helper `isPublicHostname`; the kernel's `net` module itself is not available to extensions).
- `allowed_domains` / `blocked_domains` do not exist on `WebFetch` (as in Claude Code).

### 7.2 Results and prompt injection

- The kernel filters search results by `allowed_domains` / `blocked_domains` itself even when the
  provider honored them.
- Search snippets and extracted answers are untrusted text. Default `ask` (decided) is the main
  defense against a page steering the agent to exfiltrate data through a crafted URL; the approval
  card shows the full URL. Hooks (`tool.preExecute`) let an org add a policy (e.g. a domain
  allowlist) without core changes.

## 8. Event log and replay

- Both are ordinary tool calls: `tool_call` / `tool_result` in the log; the model sees only the
  recorded result. Full-run replay uses recorded results and never calls a provider or the
  extraction model (`RecordedToolPipeline`, unchanged).
- The extraction call is not model-visible to the main model; its `usage` event is not either
  (like `title`); no `DriftReason`.
- Both specs are fixed text, stored in `tool_specs` by `specHash` like every builtin; the date
  lives in the recorded result (§3.1). No new `DriftReason`.
- The extraction call fires hooks live; replays fire none (existing rule).

## 9. Claude Code compatibility

- `CLAUDE_CODE_TOOL_MAP` (`runtime/context/claude-tools.ts`): move `WebFetch` and `WebSearch` from
  "not available" to the same-name list. Only snapshots written afterwards change (existing rule).
- The Claude agent translation (`catalog/claude-translate`) maps `tools: WebFetch, WebSearch` to the
  builtin refs instead of dropping them with `agent_tools_unmapped`; fixtures and the translation
  report tests change accordingly.

## 10. Multi-replica

- No process state. The org default is read from PG per resolution.
- A fetch cache like Claude Code's 15-minute cache is optional: if built, it lives in Redis keyed by
  `(orgId, provider, url)` with a 15-minute TTL, storing the provider's markdown (never the
  extraction, which depends on `prompt`) **(designer's call**: build it; it saves the org's provider
  quota when an agent reads the same page twice).

## 11. The `jina` plugin (`capybara-hq/plugins`)

- `plugins/jina`, `provides: ["web-search@1", "web-fetch@1"]`, registers no tools.
- `config.org`: `{ apiKey: secret(z.string().min(1)) }`; `configured()` checks it.
  `config.deployment`: `{ searchUrl, readerUrl }` defaulting to `https://s.jina.ai` /
  `https://r.jina.ai` (for tests and proxies).
- `permissions.network`: `["s.jina.ai", "r.jina.ai"]`.
- Search: `GET s.jina.ai/?q=…` with `Authorization: Bearer`, `Accept: application/json`, asking for
  snippets only (no page content) to save quota; one allowed domain maps to Jina's site filter,
  several are left to the kernel's filter. Reader: `GET r.jina.ai/<url>` with
  `Accept: application/json` and markdown output; `finalUrl` from the response. The builder checks
  the current header names and response shape against Jina's docs.
- HTTP status -> `WebProviderError` kind: 401/403 `auth`, 402/429 `rate_limited`, 404/422 `not_found`
  or `invalid`, 5xx / network `unavailable`. `signal` passed to every `fetch`. No token in logs or
  errors.
- Tests in `plugins/jina/test` against a fake Jina HTTP server; live tests gated by
  `CAPYBARA_TEST_JINA_API_KEY`.
- Ships after the core release carrying the SDK points.

## 12. Testing in core

- A fake provider extension `packages/testing/fixtures/extensions/fake-web` providing both points
  (scripted results, scripted errors, a redirect case), and a second one (`fake-web-2`) for the
  default-provider rules.
- Kernel tests: resolution rules (§6) including disable / re-enable of the default; the two tools
  through the real pipeline with model-fake (approval `ask`, `session` and `always` grants, sub-agent
  approval routing); URL rules; domain filtering; error mapping; extraction purpose mapping and
  fallback (a sub-agent uses its own model), `usage` event and `subagent_tokens_used`, model hooks
  on the extraction (observe and policy denial); Redis cache TTL; replay never calls the provider.
- `check:extension-permissions` / registry tests for the new `selection` flag.
- Web: the default-provider select, the tool rows (kinds, verbs, summaries), the approval card.

## 13. Delivery

1. Core PR 1: SDK points + `WebProviderError` + `selection` flag, org default table / API / web,
   builtins, extraction purpose, Claude Code map and translation, fake extensions, tests, docs
   (`writing-tools`, `writing-extensions` skills, AGENTS.md rules line), changesets.
2. Release (rc).
3. Plugins PR: `plugins/jina` against the released SDK, marketplace entry.

## 14. Left to the builder

- Exact wording of descriptions, errors, the extraction system prompt and the web strings.
- Config key names under `web.*` and their defaults (via `adding-config`).
- Whether `WebProviderError` kinds need a finer split once Jina's real responses are seen.

## As built

Deviations from this design, accepted during implementation:

- No builtin list API; the agent form reads `GET …/extension-points/available`.
- `url` has no `format: "uri"` in the input schema (§3.2); the kernel validates it.
- The page cache is `WebPages` on `CacheService` (`kc-cache`), key prefix `cache:`.
- The org / actor columns of `org_extension_point_defaults` are `text` (ids are text).
- An empty page is the error "... use another URL".
- Giving both domain lists is a `ToolError` after approval, not a schema error.
- `StepLog` moved to its own `StepLogModule`.
- The web points are in `TRACKED_EXTENSION_POINTS`, so in-flight provider calls are drained.
- `WebFetch` has its own time limit, the hot config `web.fetch.timeoutMs` (default 180 000), instead
  of `tools.timeoutMs`: the provider's fetch and a large extraction call share it.
- A redirect between a host and its `www.` form (one leading `www.` stripped on both sides) is the
  same host: extracted with a `Final URL` line, not returned as a redirect. A final URL WebFetch may
  not fetch is echoed in the error only when it parses and is at most 2 000 characters.
- The 2 000-character URL limit applies to the normalized URL too (after the https upgrade).
- Domain list entries are converted to ASCII (IDNA, `domainToASCII`) before matching result hosts.
- The extraction call reads the target model's limits first (`ModelPurposesService.chatLimits`, the
  same mapping and fallback as `chat`) and cuts the page so the estimated request plus the answer
  cap plus headroom (10 % of the window, at least 1 024 tokens) fits the context window.
- The page in the extraction message sits between a random per-call tag (`<page-<16 hex>>`) that
  the system prompt names, so page text cannot fake the `Prompt:` after it.
