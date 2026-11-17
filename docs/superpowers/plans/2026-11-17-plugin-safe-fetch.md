# Plugin Safe Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugins request URLs an org admin or member supplied through `ctx.net.fetch`, which applies the kernel's network rules, with internal endpoints allowed per org by a super admin.

**Architecture:** The SDK declares `ctx.net` and `NetDeniedError`; the kernel builds `ctx.net.fetch` on `safeFetch` with a per-call `NetPolicy` made from the org's allowances (table `org_network_allowances`, super-admin managed). Core fixtures move first; the official plugins move after the SDK release (Part 2, plugins repository).

**Tech Stack:** TypeScript, NestJS kernel, Kysely/PostgreSQL, undici (`safeFetch`), zod, Next web app, vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-plugin-safe-fetch-design.md`

## Global Constraints

- Only URLs an org admin or member can set go through `ctx.net.fetch`; super-admin-only URLs keep `fetch`.
- Private / loopback addresses refused unless the target matches the org's allowances; link-local always refused.
- Allowance entries: a host or `*.domain` (https, any port), or an origin `http(s)://host:port` (exactly that origin, plain http allowed); IP / CIDR within `MIN_CIDR_PREFIX`.
- A call without an org gets public addresses only.
- Redirects never followed; `redirect: "manual"` returns the 3xx response; default `follow` fails with `net.redirect`.
- No body size cap by default; one pinned agent per request; `net.httpsProxy` / `net.noProxy` honoured.
- `net.allowInsecureLoopback` is tests-only; the connector plugins' own `allowInsecureLoopback` is removed (no alias, pre-0.1.0).
- Allowances: written only by a super admin, audited `org.network_allowance_added` / `org.network_allowance_removed`, a Platform operation per route, org admins read-only, members nothing.
- Refusal message names the host and says to ask a super admin to allow the internal endpoint for the organization.
- Plugins detect the error by `err.name === "NetDeniedError"`, never `instanceof`.
- AGENTS.md: English code and comments, zh/en UI copy (zh: 超级管理员, 平台, never 企业), migrations `IF NOT EXISTS`, changesets, `pnpm gen:sdk-api`.

## Review Focus

- An allowance entry `http://mcp.internal:8080` must not allow `http://mcp.internal:9090` or `https://other.internal` (Task 3 test).
- A DNS name that resolves to a private address is refused even when an IP-literal CIDR allowance covers that address (Task 3 test).
- Org A's allowance never lets org B's connector reach the host (Task 3 test).
- A streamed response (SSE / chunked) reaches the plugin incrementally, not buffered (Task 3 test).
- Removing an allowance takes effect on the next request without restart (Task 3 test).

---

## Part 1: core (capybara-hq/core)

### Task 1: SDK contract

**Files:**
- Create: `packages/plugin-sdk/src/net.ts`
- Modify: `packages/plugin-sdk/src/ctx.ts` (add `net` to `ExtensionContext`), `packages/plugin-sdk/src/connector.ts` (`ConnectorOpenArgs.orgId`), `packages/plugin-sdk/src/index.ts`, `packages/plugin-sdk/api/plugin-sdk.api.md` (generated)
- Test: `packages/plugin-sdk/test/net.test.ts`

**Interfaces:**
- Produces: `interface ExtensionNet { fetch(url: string, init?: RequestInit, opts?: { orgId?: string }): Promise<Response> }`; `ctx.net: ExtensionNet`; `class NetDeniedError extends Error { name: "NetDeniedError"; code: NetDeniedCode; host: string }`; `type NetDeniedCode = "net.insecure_url" | "net.private_address" | "net.dns_failed" | "net.redirect" | "net.proxy_refused"`; `function isNetDeniedError(e: unknown): e is NetDeniedError` (by `name`); `ConnectorOpenArgs.orgId: string` (required; the kernel always passes the org the session serves).

- [ ] **Step 1:** Test `isNetDeniedError` true for a `NetDeniedError` and for a plain object `{ name: "NetDeniedError", code, host, message }` (another package copy), false otherwise.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/plugin-sdk/test/net.test.ts`; expect FAIL (module missing).
- [ ] **Step 3:** Implement `net.ts` and the type additions; doc comments state the rule (person-supplied URLs use `ctx.net.fetch`; `opts.orgId` scopes internal allowances; redirects never followed).
- [ ] **Step 4:** Run the test (PASS), `pnpm gen:sdk-api`, `pnpm typecheck`.
- [ ] **Step 5:** Changeset `.changeset/sdk-ctx-net.md` (`@capybara-hq/plugin-sdk` minor); commit `feat(plugin-sdk): ctx.net.fetch and NetDeniedError`.

### Task 2: Allowances store and config

**Files:**
- Create: `packages/kernel/src/migrations/0145_org_network_allowances.sql`, `packages/kernel/src/orgs/network-allowances.service.ts`
- Modify: `packages/kernel/src/db/kernel-schema.ts`, `packages/kernel/src/config/schema.ts` (`net.allowInsecureLoopback: boolean, default false`, description "Testing only: …"), `docs/config.md` (generated), the orgs module
- Test: `packages/kernel/test/orgs/network-allowances.test.ts`, `packages/kernel/test/migrations/0145.test.ts`

**Interfaces:**
- Produces: table `org_network_allowances (id uuid pk, org_id uuid FK orgs ON DELETE CASCADE, entry text, created_by uuid null, created_at timestamptz, UNIQUE(org_id, entry))`; `OrgNetworkAllowances.list(orgId): Promise<{ id: string; entry: string; createdAt: Date; createdBy: string | null }[]>`; `.add(orgId, entry, actorId): Promise<row>` (`@Transactional`, audit `org.network_allowance_added` detail `{ entry }`, error `org.network_allowance_invalid` 400 with the reason, idempotent on duplicate); `.remove(orgId, id, actorId)` (audit `org.network_allowance_removed`); `.policyFor(orgId): Promise<{ allowPrivateHosts: string[]; trustedOrigins: string[] }>` (origins → `trustedOrigins`, host/wildcard/IP/CIDR → `allowPrivateHosts`); `function allowanceEntryProblem(entry: string): string | null` (reuses `privateHostEntryProblem`, accepts `http(s)://host:port` origins, refuses link-local and paths/queries).

- [ ] **Step 1:** Tests: entry validation table (`mcp.internal` ok, `*.corp.example` ok, `http://mcp.internal:8080` ok, `http://mcp.internal:8080/x` refused, `169.254.169.254` refused, `10.0.0.0/4` refused by prefix); add/list/remove with audit rows; org deletion cascades; `policyFor` splits entries; migration test (`IF NOT EXISTS`, cascade).
- [ ] **Step 2:** Run them; expect FAIL.
- [ ] **Step 3:** Implement migration, schema types, config field, service, error code with en/zh copy (`apps/web/messages`).
- [ ] **Step 4:** Run tests, `pnpm gen:config-docs` (or the repo's generator named in adding-config), `pnpm check`.
- [ ] **Step 5:** Commit `feat(kernel): org network allowances store`.

### Task 3: Kernel `ctx.net`

**Files:**
- Create: `packages/kernel/src/ctx/net.ts`
- Modify: `packages/kernel/src/ctx/create-ctx.ts` (wire `net`), `packages/kernel/src/net/safe-fetch.ts` (option `redirects: "refuse" | "return"`), the connector session opener in `packages/kernel/src/tools/` (pass `orgId` in `ConnectorOpenArgs`)
- Test: `packages/kernel/test/ctx/net.test.ts`

**Interfaces:**
- Consumes: `OrgNetworkAllowances.policyFor`, `safeFetch`, `NetDeniedError` (kernel) mapped to the SDK error shape.
- Produces: `createExtensionNet(deps: { config: KernelConfigService; allowances: OrgNetworkAllowances; log: Logger; plugin: string; signal: AbortSignal }): ExtensionNet`.

- [ ] **Step 1:** Tests (local fake servers):
  - public https allowed; `http://` non-loopback refused `net.insecure_url`; a host resolving to 10.x refused `net.private_address` with the refusal copy;
  - org allowance `http://127.0.0.2:<port>` (origin) allows exactly that origin; another port refused;
  - CIDR allowance `10.1.0.0/16` allows `http://10.1.2.3` literal but a DNS name resolving there is refused;
  - org B with no allowance refused the host org A may reach; no `orgId` → public only;
  - removing the allowance refuses the next request;
  - `redirect: "manual"` returns the 302; default follow fails `net.redirect`;
  - a chunked response yields its first chunk before the server ends;
  - abort via `ctx.signal`;
  - with `net.httpsProxy` set (the existing proxy test fixture), an https request tunnels through it and an IP-literal private target is still refused;
  - with `net.allowInsecureLoopback` true, `http://127.0.0.1` allowed; link-local refused regardless.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement: per call build `NetPolicy { allowInsecureLoopback: cfg.net.allowInsecureLoopback, ...(orgId ? await allowances.policyFor(orgId) : { allowPrivateHosts: [], trustedOrigins: [] }), proxy from cfg.net }`; call `safeFetch` without `maxBytes`; rethrow denials as the SDK error shape; `warn` log `{ plugin, orgId, host, code }`.
- [ ] **Step 4:** Run tests, typecheck.
- [ ] **Step 5:** Commit `feat(kernel): ctx.net.fetch on safeFetch with per-org allowances`.

### Task 4: Routes and Platform operations

**Files:**
- Create: `packages/kernel/src/admin/org-network.controller.ts`, `packages/kernel/src/admin/org-network.schemas.ts`
- Modify: `packages/kernel/src/orgs/` (org read route), `packages/kernel/src/platform/ops/orgs.ops.ts`, errors registry
- Test: `packages/kernel/test/admin/org-network.http.test.ts`, platform parity test passes

**Interfaces:**
- Produces: `GET|POST /api/v1/admin/orgs/:orgId/network-allowances`, `DELETE /api/v1/admin/orgs/:orgId/network-allowances/:id` (super admin); `GET /api/v1/orgs/:orgId/network-allowances` (org admin, read-only, `org.update` level per `orgs/roles.ts`); schemas `NetworkAllowanceBody { entry: string }`, `NetworkAllowanceView { id, entry, createdAt }`; ops `admin.org-network-allowances` (list), `admin.org-network-allowance-add`, `admin.org-network-allowance-remove`, `orgs.network-allowances` (read), each `mirrors` its route.

- [ ] **Step 1:** Tests: super admin add/list/remove; org admin of the org reads but POST is 403 / route not reachable; member 403; another org 404; invalid entry 400 code `org.network_allowance_invalid`; audit rows; ops return the same rows; parity.
- [ ] **Step 2–4:** Run (FAIL) → implement (controllers call the service, no new logic in ops) → run + `pnpm check`.
- [ ] **Step 5:** Commit `feat(kernel): routes and Platform operations for org network allowances`.

### Task 5: Web

**Files:**
- Modify: `apps/web/src/app/(app)/admin/orgs/view.tsx` (row action "Internal endpoints" opening a sheet with the list, add field, remove), `apps/web/src/app/(app)/settings/organization/` (read-only "Internal endpoints" section for org admins), `apps/web/src/lib/` (queries/mutations), `apps/web/src/lib/audit-actions.ts`, `apps/web/messages/{en,zh}.json`
- Test: `apps/web/test/org-network-allowances.test.tsx`

- [ ] **Step 1:** Tests: super admin adds and removes an entry (mutation bodies); invalid entry shows the kernel message; org admin sees the list read-only with copy telling them a super admin manages it; member sees no section; audit labels for both actions exist in zh and en.
- [ ] **Step 2–4:** FAIL → implement with design components only (writing-web-ui) → PASS, `pnpm check`.
- [ ] **Step 5:** Commit `feat(web): manage org internal endpoints`.

### Task 6: Core fixtures, docs and release

**Files:**
- Modify: `packages/testing/fixtures/extensions/fake-connector/src/index.ts`, `fake-openapi` fixture (use `ctx.net.fetch` with `args.orgId`; drop their `allowInsecureLoopback` config), kernel test config helpers in `packages/testing/src` and `packages/kernel/test/helpers` (set `net.allowInsecureLoopback: true` where fake servers run on loopback), `.agents/skills/writing-extensions/SKILL.md`, `.agents/skills/writing-connectors/SKILL.md`, `AGENTS.md` ("every admin-supplied URL goes through `packages/kernel/src/net`" also names `ctx.net` for plugins)
- Test: the connector suites (`packages/kernel/test/tools/connectors.http.test.ts`, the fake-openapi tests) green

- [ ] **Step 1:** Switch fixtures; run the connector suites; fix configs until green.
- [ ] **Step 2:** Docs; changeset `.changeset/ctx-net-kernel.md` (`@capybara-hq/kernel`, `@capybara-hq/testing`, `@capybara-hq/capybara` patch).
- [ ] **Step 3:** `pnpm verify`; commit `chore: fixtures and docs follow ctx.net`.

## Part 2: official plugins (capybara-hq/plugins, after the core release)

### Task 7: connector-mcp, connector-openapi, deepseek

**Files:**
- Modify: `plugins/connector-mcp/src/session.ts`, `plugins/connector-mcp/src/index.ts` (drop `allowInsecureLoopback`), `plugins/connector-openapi/src/http.ts` + index, `plugins/deepseek/src/*` (org-bound calls use `ctx.net.fetch` with `opts.orgId` when the org's `baseUrl` copy is in effect), any other plugin with an `orgAccess` URL field (grep config schemas), manifests' minimum `sdk`, `.agents/skills/writing-connectors|writing-model-providers|writing-extensions`, deps bump, changeset `core-rcN-deps`-style
- Test: each plugin's unit test injects a fetch; new test per plugin: a private address is refused with the plugin's actionable error (connector `ToolError` `invalid_input`; provider `ModelError` `invalid_request`), naming the host; kernel e2e tests set `net.allowInsecureLoopback`

- [ ] **Step 1:** Failing refusal tests per plugin.
- [ ] **Step 2:** Implement; map `isNetDeniedError` to each plugin's error.
- [ ] **Step 3:** `pnpm verify` in the plugins repository; commit `feat: connectors and org base URLs use ctx.net.fetch`.
