# Postgres row level security as the tenant backstop

Issue: #115 (part 2). Status: phases 2–3 approved and being built (decisions in §10, 2026-11-24);
phases 4–5 wait for the numbers of §8. Written against core `main` at `d0860858c`. Part 1 of the issue, the static
check `check:org-filter`, is its own PR (see §2).

Related: the Nest kernel spec (`2026-10-28-nest-kernel-design.md`: `KernelDb`, `@Transactional`,
the role modules), the transactional outbox spec (`2026-11-12-transactional-outbox-design.md`),
the writing-kernel-api and writing-migrations skills.

## 1. Problem

Tenant isolation lives only in application code. 59 of the kernel's tables have an `org_id`
column (52 `NOT NULL`, 7 nullable for platform or account-wide rows: `api_tokens` (personal
tokens), `audit_events`, `model_purpose_mappings`, `model_disabled`, `outbox`,
`extension_client_reports`, `plugin_import_staging`); there is no row level
security policy anywhere. Every query on those tables must add its own `org_id` filter or reach the
row through one that does. A single missing filter is a cross-org read or write, and the
cross-org tests are samples.

## 2. What part 1 already gives, and what it cannot

`check:org-filter` (tools/checks/src/org-filter.ts) requires every kernel `selectFrom` /
`updateTable` / `deleteFrom` / `mergeInto` / `sql` read on an org-scoped table to filter by
`org_id`, or to carry `// org-filter: <reason>`. Its first run found 633 sites: about 270 now filter
by `org_id` (most were by-primary-key reads and writes of a row the same method had already loaded
under an org filter), the rest are covered by 238 reasoned markers (deployment-wide sweeps and
relays, super-admin services, job payloads the kernel wrote, ids checked under the org earlier in
the request). One real, low-impact cross-org read was fixed (a schedule approval card could show
the name of another org's channel connection, given its UUID).

What a static check cannot do, and RLS would:

- see the value: `where("org_id", "=", wrongOrg)` passes;
- see helpers, dynamic table names, joins onto an org-scoped table from a table without `org_id`;
- judge a marker's reason: an exempted query is trusted forever;
- cover code outside `packages/kernel/src` that reaches the same pool (the CLI, tests, extension
  `ctx.db` if it ever touches the `capybara` schema).

## 3. Decision in one paragraph

Enable and **force** row level security on every kernel table with an `org_id` column, with one
policy per table keyed on `current_setting('capybara.org_id', true)`. The kernel carries an **org
scope** in AsyncLocalStorage (set once at each entry point: the org guard of an HTTP request, the
job runner from the job's org, a run's claim, the gateway's connection), and `KernelDb` applies it
to the connection every query runs on: `set_config(..., true)` as the first statement of each
transaction, and `set_config(..., false)` on every checkout of a pool connection for a read outside
one (§5.2). Deployment-wide work runs in an explicit **platform scope** (`asPlatform(reason, fn)`),
which the policies admit through a second setting; the `// org-filter:` markers of part 1 are the
inventory of where it is needed. A third setting, `capybara.rls`, switches a connection between
`enforce` and `off`, so the policies ship dark and are turned on by config per deployment without
DDL (§7).

## 4. Policies

For a `NOT NULL` `org_id` table `t`:

```sql
ALTER TABLE capybara.t ENABLE ROW LEVEL SECURITY;
ALTER TABLE capybara.t FORCE ROW LEVEL SECURITY;  -- the kernel connects as the table owner
CREATE POLICY org_scope ON capybara.t
  USING (capybara.rls_admits(org_id))
  WITH CHECK (capybara.rls_admits(org_id));
```

with one helper, so the rule lives in one place:

```sql
CREATE OR REPLACE FUNCTION capybara.rls_admits(row_org text) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(current_setting('capybara.rls', true), '') <> 'enforce'
      OR current_setting('capybara.scope', true) = 'platform'
      OR row_org = current_setting('capybara.org_id', true)
$$;
```

- **Fail closed when enforcing**: no org scope set means `current_setting(..., true)` is null and
  no row matches; an unscoped path breaks loudly in tests instead of leaking.
- **Nullable `org_id`** (platform rows): reads admit `org_id IS NULL` too for the tables where the
  platform row is meant to be visible to orgs (decided per table in the plan; `outbox` and
  `plugin_import_staging` are not), writes of a null row need the platform scope.
- `org_id` is `text` everywhere (69 migrations), so no cast; the helper is `STABLE`, so the planner
  evaluates the settings once per statement. `FORCE` is needed because the kernel connects as the
  owner of the `capybara` schema, which RLS otherwise exempts.
- Inserts are covered by `WITH CHECK`: a row written for another org fails.
- Child tables without `org_id` (`conversation_events`, `runs`, `conversation_queue`,
  `lg_checkpoints`, `agent_versions`, `agent_members`, `connector_tools`, `channel_threads`, ...)
  get no policy in this design; they are reached through a parent the policy covers in almost
  every query. Open question 6.

## 5. Prerequisites in the kernel

### 5.1 The org scope

A new `infra/database/org-scope.ts`: an AsyncLocalStorage holding `{ kind: "org", orgId }` or
`{ kind: "platform", reason }`, with `withOrgScope(orgId, fn)`, `asPlatform(reason, fn)` and
`currentScope()`. Where it is set (each once, at the boundary, never inside domain services):

| Entry | Scope |
|---|---|
| HTTP routes behind the org guard (`@OrgAction`, the workspace routes) | the guarded org |
| Super-admin routes (platform guard) | platform |
| `@Public` routes (login, webhooks, embeds) | none until they resolve an org; then `withOrgScope` |
| Queue consumers (`runJob`) | the job's org (`outbox.org_id` already records it; job data carries `orgId` for org work), else platform with the job name as reason |
| `@LockedCron` / `@LockedInterval` sweeps | platform; a sweep that handles each org's rows in turn enters `withOrgScope` per org |
| Run execution (`RunExecution.withClaim`) | the run's org |
| Gateway long connections (channels, dial-in) | platform for connection management; each inbound event enters its org once resolved |
| Extension calls made for an org (`ctx` of an org-bound call) | that org |
| Migrator, CLI admin commands, bootstrap | platform |

The `// org-filter:` markers become reviewable: a marker that says "deployment-wide" should sit
inside an `asPlatform`, and one that says "checked earlier" inside an org scope. A follow-up rule
of `check:org-filter` can ask for that (open question 7).

### 5.2 Getting the setting onto the connection

`SET LOCAL` (or `set_config(name, value, true)`) applies only inside a transaction. Today `KernelDb`
resolves each query to the transaction in AsyncLocalStorage or, outside `@Transactional`, to the
pool: most reads run outside a transaction (there are 506 `@Transactional(` methods, but the read
paths of list and detail pages, the run loop's reads and the jobs' reads mostly are not in one).

Two mechanisms, both in `infra/database`, no change to services:

1. **Inside a transaction**: `TransactionHost` runs `SELECT set_config('capybara.org_id', $1,
   true), set_config('capybara.scope', $2, true), set_config('capybara.rls', $3, true)` as the
   first statement after `BEGIN` of every root transaction (one extra round trip per transaction).
   A nested `requires_new` transaction does the same. A transaction joined under a different scope
   than the one it was opened in is refused (a programming error).
2. **Outside a transaction**: a Kysely driver wrapper on the pool sets the three values
   session-level (`is_local = false`) on **every** connection checkout, before the query, from
   the current scope (empty values when there is none). Because every checkout sets all three, a
   connection returned to the pool carries no scope into the next user. One extra round trip per
   pool query.

Rejected: wrapping every pool read in its own transaction (`BEGIN`, `set_config`, query, `COMMIT`:
three extra round trips per read, and it changes snapshot behaviour of multi-query reads that are
not transactional today); a CTE that calls `set_config` in the query itself (Postgres does not
guarantee the CTE is evaluated before the policy predicate).

Constraint: mechanism 2 needs a session-capable connection, so a transaction-mode pooler
(PgBouncer `pool_mode = transaction`) in front of the kernel is not supported with RLS on.
Deployments today connect directly (`database.url`, `poolMax`); open question 2.

### 5.3 Roles

- **API**: org guard sets the scope; super-admin controllers run under `asPlatform`.
- **Worker**: every processor goes through `runJob`, which sets the scope from the job. Jobs whose
  data lacks an org today are listed by the plan and either gain `orgId` (expand-only, the outbox
  already stores it) or run under platform with a reason.
- **Gateway**: long connections are platform-scoped; per-event work enters the org scope once the
  connection or device has resolved it (the same place it already checks the org).

### 5.4 Locks, outbox, listeners

Advisory locks, `FOR UPDATE` and the outbox are unaffected (RLS filters rows, not locks). The outbox
relay reads every org's rows and runs under platform. `afterCommit` hooks run after the transaction
and inherit the AsyncLocalStorage scope of their caller.

## 6. What changes for code and tests

- Services do not change; `withOrgScope` / `asPlatform` are called only at entry points and in the
  sweeps that iterate orgs.
- Tests that seed rows through `app.get(KernelDb)` outside a request run under a test helper
  `asPlatform("test seed", ...)`, or the test app starts with `rls: off` except in a dedicated RLS
  suite (§7, phase 2).
- A new error code is not needed: a policy violation on write is a Postgres error
  (`new row violates row-level security policy`), which is a kernel bug and stays a 500 with the
  log line.

## 7. Migration path

1. **Done (part 1)**: `check:org-filter` and the missing filters.
2. **Scope plumbing, RLS absent**: the org scope, the entry points, `TransactionHost` and the pool
   wrapper setting the values (with `capybara.rls = off`). Measures the round-trip cost alone.
   A debug assertion in tests: a query on an org-scoped table with no scope fails the test.
3. **Policies, dark**: one migration (`NNNN_rls_policies.sql`, `IF NOT EXISTS` style, the helper
   function and one policy per table; a later table with `org_id` adds its policy in its own
   migration, and `check:org-filter` gains a rule that every org-scoped table has a policy).
   `capybara.rls` stays `off`: no behaviour change.
4. **Enforce in CI**: the integration and container projects run with `database.rls: enforce`;
   fix every unscoped path the failures show.
5. **Enforce by default**: new kernel config `database.rls` (`enforce` | `off`, default `enforce`,
   not hot), so a deployment can switch it off without a migration if a path was missed. Remove
   the switch once a release has run enforced on prod without incidents (open question 8).
6. **Optional hardening**: a non-owner runtime role (owner only for migrations), so `FORCE` is not
   needed and a bypass needs `SET capybara.scope = 'platform'` from code, not ownership.

Rollback at any step: `database.rls: off` (phase 5) or not deploying the phase.

## 8. Cost, and how to measure it

Expected costs: one extra round trip per pool query and per transaction (§5.2); the policy
predicate on every row an org-scoped scan touches (cheap: most queries already filter by `org_id`,
and `rls_admits` is `STABLE`); the planner can no longer use some plans across joined org-scoped
tables when a policy blocks predicate push-down (`leakproof` matters only for user functions in
quals; Kysely queries use operators, which are leakproof).

Measurement plan, run after phase 2 and again after phase 4, against the same commit with the
switch `off` and `enforce`:

- **Round trips**: count statements per request with `pg_stat_statements` for four flows: open
  the workspace home, open a conversation with 200 events, one agent turn with three tool calls, a
  sweep (`run-orphan-check`). Expect +1 per transaction and per pool query.
- **Latency**: a k6 (or autocannon) script over those flows, 50 virtual users, 5 minutes, on the
  dev stack with the database one network hop away (the prod layout); compare p50 / p95 / p99 of
  the HTTP flows and of a run turn's wall time.
- **Database CPU**: `pg_stat_statements.total_exec_time` per query id, before / after; `EXPLAIN
  (ANALYZE, BUFFERS)` of the 20 most frequent queries with RLS enforcing.
- **Suite time**: `kernel-integration` wall time with `off` and `enforce`.

Proposed bar for phase 5: p95 of each HTTP flow within +5 % and a run turn within +3 %, database
CPU within +10 %. If the pool round trip alone breaks the bar, the fallback is to scope only
transactions and make org-scoped reads outside a transaction a check finding (they move into
read-only transactions over time).

## 9. Open questions for the maintainer

1. **Build RLS at all, or stop at the check?** Recommendation: build phases 2–3 (cheap, no
   behaviour change) and decide on 4–5 with the numbers from §8. The check alone leaves the value
   and the markers unverified.
2. **Transaction-mode poolers**: RLS on means no PgBouncer `pool_mode = transaction` in front of the
   kernel. Recommendation: accept and document it (the kernel already holds advisory locks and
   session-sized pools that assume direct connections).
3. **Bypass by setting or by role**: a `BYPASSRLS` role needs a second pool and URL per deployment.
   Recommendation: the setting (`capybara.scope = platform`) on one role now, the non-owner runtime
   role later (phase 6).
4. **Nullable `org_id`**: which platform rows are readable by orgs through the policy.
   Recommendation: decide per table in the plan; default not readable (platform scope only).
   `model_purpose_mappings` and `model_disabled` (platform defaults every org reads) admit
   `org_id IS NULL` on read; `outbox`, `plugin_import_staging`, `extension_client_reports` and
   platform `audit_events` stay platform-only; personal `api_tokens` are looked up by token hash
   before any org is known, so that lookup runs under `asPlatform`.
5. **Share-gated tables** (`owner_org_id` on `platform_skills`, `platform_themes`, connector and
   agent templates): out of scope here; the share gate `owner_org_id IS NULL OR shareable` stays in
   code. Recommendation: revisit once RLS runs, as a second policy family.
6. **Child tables without `org_id`** (`conversation_events`, `runs`, `conversation_queue`, ...):
   Recommendation: no policy now; denormalize `org_id` (expand-only) onto `conversation_events` and
   `runs` later if review shows queries that reach them by id alone, since they hold the content.
7. **Keep `check:org-filter` after RLS?** Recommendation: yes (it is cheap and catches the bug
   before a test does); add a rule that a marker saying "deployment-wide" sits in `asPlatform`.
8. **Keep the `database.rls` switch forever?** Recommendation: remove it one release after prod ran
   enforced without incidents; before 0.1.0 no compatibility layer is owed.
9. **Extension schemas** (`plugin_<name>` tables with an org column, through `ctx.db`):
   Recommendation: out of scope; extensions are full trust (AGENTS.md), and the kernel cannot know
   their columns. A later SDK helper could add the same policy to a table an extension declares.

## 10. Decisions (maintainer, 2026-11-24)

The maintainer approved the nine recommendations of §9:

1. **Build phases 2–3 now**, with no behaviour change: the scope plumbing and the policies ship
   dark (the `capybara.rls` setting off, the kernel config default off). Phases 4–5 are decided
   later from the numbers of §8, against the bar: p95 of each HTTP flow +5 %, a run turn +3 %,
   database CPU +10 %.
2. **No PgBouncer transaction mode with RLS on**: accepted and documented (the config field's
   description and `docs/config.md`).
3. **Bypass by setting** (`capybara.scope = platform`) on the existing role now; the non-owner
   runtime role stays phase 6.
4. **Nullable `org_id` per table** as listed in §9.4: `model_purpose_mappings` and `model_disabled`
   admit `org_id IS NULL` on read; `outbox`, `plugin_import_staging`, `extension_client_reports`,
   platform `audit_events` and personal `api_tokens` are platform-only (the token lookup by hash
   runs under `asPlatform`).
5. **Share-gated `owner_org_id` tables**: out of scope.
6. **Child tables without `org_id`**: no policy for now.
7. **Keep `check:org-filter`**, with a new rule: a marker whose reason says "deployment-wide" sits
   inside an `asPlatform` call (rule `org-filter-platform`), and a second one: every org-scoped table
   has its policy in a migration (rule `org-filter-policy`).
8. **Remove the switch** one release after prod has run enforced cleanly.
9. **Extension schemas**: out of scope.

Made while building phases 2–3 (within the decisions above):

- **The switch is `db.rls`** (`CAPYBARA_DB__RLS`), in the existing `db` section of the kernel
  config rather than a new `database` section, with three values: `off` (default: the pool sends
  nothing, so phase 2 costs nothing until a deployment opts in), `scoped` (every connection carries
  the scope with `capybara.rls = off`: the policies admit every row; this is the mode that measures
  the round-trip cost of §8 and runs the unscoped-query check) and `enforce` (`capybara.rls =
  enforce`). Not hot. Phase 5 changes the default, not the field.
- **One mechanism on the driver** carries both cases of §5.2: a Kysely driver wrapper on the kernel
  pool (`infra/database/scoped-dialect.ts`) sets the scope transaction-local as the first statement
  after `BEGIN`, and session-level before the first query of a checkout outside a transaction. Every
  checkout starts with an unknown scope, so its first statement always writes all three settings;
  `TransactionHost` and the services do not change.
- **A scope entered inside a transaction applies to the queries run in it** instead of being refused
  (§5.2 said "refused"): the connection is re-scoped (`set_config(…, true)`) before the first query
  in the new scope and again when the old one resumes. The deployment-wide markers inside org
  transactions (an existence check across orgs during an org's write, the platform publication)
  need `asPlatform` there, and the refusal would have forced them out of their transactions. Queries
  on one connection run one after another, so a re-scope and its query are never split.
- **The test assertion of phase 2** (an unscoped query on an org-scoped table fails the test) is a
  seam, `setUnscopedQueryCheck`, called by the scoped pool; phase 4 installs it in the integration
  setup together with `enforce`, when the unscoped paths it finds get fixed. Turning it on for the
  whole suite now would be phase 4 itself.
- **HTTP requests** get an empty scope slot in the Fastify `onRequest` hook (where the log context
  starts); `OrgGuard` binds the guarded org, `AuthGuard` binds platform on a `@SuperAdmin` route
  without `@OrgAction`, and an extension route binds its caller's org (or platform for a super
  admin's embed). A Nest guard cannot wrap the handler in an ALS run, hence the slot.
- **Platform is never a silent fallback** (security review of phase 2): `runJob` scopes a job to
  its data's `orgId`; a queue whose work is deployment-wide says so (`runJob(…, { platform: reason
  })`: maintenance, plugin scope sync, extension lifecycle hooks); any other job runs with no scope
  (§5.1's "else platform" is dropped), so a missing org fails closed and the unscoped-query check
  reports it in phase 4. Callbacks that outlive their registrant start with no scope: the bus
  subscriber's shared connection, like it already drops the transaction and the log context.
- **Left for phase 4** (found by the review, all fail closed or stay as they are while `db.rls` is
  not `enforce`): the kernel services behind org-bound extension calls (`ctx.models.embed({ orgId
  })` and the like) enter that org; what the start sequence starts keeps the platform scope
  (extension timers, the gateway's channel sockets, whose events only enqueue); the run worker's
  claim reads, the route-access check of extension routes and the session lookup run unscoped;
  `@Cacheable` keys of org data must carry the org before `enforce`, or one org's filtered view is
  cached for another.
- **Not on the scoped pool**, and so admitted whatever `db.rls` says: the migrator's own client, the
  owned startup activation session (platform work at start, before the gate opens) and extension
  pools (`ctx.db`, out of scope by decision 9).

## AGENTS.md rules touched

None changed by this spec. If phases 2–5 are built, the plan changes:

- **Multi-replica discipline**: adds "every query on an org-scoped table runs under an org scope or
  `asPlatform(reason)`; scopes are set at entry points only".
- **Migrations**: a new table with `org_id` ships its RLS policy in the same migration.
- **Kernel**: `KernelDb` and `TransactionHost` set the scope on the connection; the role modules set
  it at their entry points.

Rules this design relies on: **Multi-replica discipline** (writes in `@Transactional`, state in PG,
`LockService` outside transactions), **Migrations** (plain SQL, `IF NOT EXISTS`, applied files
immutable), **Config** (a new kernel option `database.rls`, `CAPYBARA_DATABASE__RLS`), **Before
0.1.0** (no compatibility layer for the switch).
