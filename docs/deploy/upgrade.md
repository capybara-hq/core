# Upgrading Capybara

Read the release notes of every version between yours and the target first. While Capybara is on
0.x, the plugin SDK and the HTTP API may change in breaking ways, and the release notes say how to
migrate.

## How an upgrade runs

1. **Pull the new images first.**
2. **Migrate.** Run `capybara migrate` (the compose `init` container, or a Kubernetes Job) and wait for
   it to finish.
3. **Roll `api`, `worker` and `gateway`** (and `web`) onto the new version.

Kernel migrations are expand-only and forward compatible by one version: the previous version's code
keeps working on the migrated schema, so old and new replicas can run side by side during a rolling
update. When you skip versions, old replicas may run against a schema two or more versions ahead of
them. In that case, stop them before migrating, or accept errors on them until they are replaced.

Plugin upgrades need no restart and are separate from kernel upgrades. Install the new version from
the admin console or with `capybara plugins install`. See
[.agents/skills/writing-plugins](../../.agents/skills/writing-plugins/SKILL.md).

### Docker Compose

Each release tags its commit `v<version>` (GitHub release), and the `compose.yaml` at that tag
defaults `CAPYBARA_VERSION` to that version. So the usual upgrade moves the compose file and the
images together. In a clone used as in the README quick start:

```bash
git fetch --tags
git checkout v<version>      # compose.yaml and .env.example of the new release
cd docker
docker compose pull
docker compose up -d
```

Compare your `.env` with the new `.env.example` before `up`. If you pinned `CAPYBARA_VERSION` in
`.env`, change or remove it: a pinned value wins over the compose default. Running new images with an
old compose file (only setting `CAPYBARA_VERSION`) works when the release notes say the compose file
didn't change; otherwise take the compose file of the release too.

`init` runs on every `up` and re-applies migrations. If it fails, compose doesn't start the new `api`,
`worker` and `gateway`: read `docker compose logs init`.

### Kubernetes

Run the migrate Job with the new `capybara-api` image, wait for it to complete, then update the
Deployments. Kernel replicas also apply pending kernel migrations at startup, under the same advisory
lock, so a replica that starts before the Job finishes is serialized with it rather than racing it.
Only `capybara migrate` checks the PostgreSQL version, though, so keep the Job.

## Migration locking

- Kernel migrations take a session-level advisory lock (`capybara-migrate:capybara`) for the whole
  run. Concurrent migrators (the Job, `init`, starting replicas) wait for it instead of running twice.
  Plugin schemas have their own lock.
- **Each migration file runs in its own transaction.** A failure rolls back that file and stops the
  run. The files before it stay applied, and the next run continues from the failed file.
- Kernel migrations set **no `lock_timeout` and no `statement_timeout`**. A migration that needs a
  lock held by a long-running transaction waits for it. While it waits, its own lock request queues
  ahead of new readers and writers of that table, so the table stalls. Before upgrading, check for
  long transactions in `pg_stat_activity`.
- Plugin migrations run by an install or upgrade at runtime are bounded by
  `pluginHost.migrationTimeoutSeconds` (default 300). That bound sets `statement_timeout` and a
  `lock_timeout`. `lock_timeout` only limits waiting for a lock, not the work done after the lock is
  taken, such as building an index.

## Version notes

### Upgrading across 0027 / 0028 (index builds and table locks)

Migrations `0027_model_prices.sql` and `0028_evals.sql` build indexes **non-concurrently inside the
migration transaction**. `CONCURRENTLY` can't run inside a transaction, and every migration file is
one.

- **0027** builds:
  - `conversation_events_run_idx`, a partial index on
    `conversation_events (conversation_id, run_id, seq) WHERE run_id IS NOT NULL`;
  - `conversations_agent_idx` on `conversations (org_id, agent_id, updated_at DESC)`.

  A plain `CREATE INDEX` blocks **writes** to the table until it finishes. Reads continue. New
  messages and agent runs stall until both indexes are built.
- **0028** first runs `ALTER TABLE conversations ADD COLUMN kind … CHECK (…)` and `ADD COLUMN
  eval_run_id … REFERENCES eval_runs`. Then it builds `conversations_org_kind_idx` on
  `conversations (org_id, kind, updated_at DESC, id DESC)` and the partial
  `conversations_eval_run_idx`.
  - The `ALTER TABLE` takes an `ACCESS EXCLUSIVE` lock, and the transaction holds it until the
    migration commits: through the CHECK and foreign-key validation scans and through both index
    builds.
  - So `conversations` is closed to **reads as well as writes** for the whole migration. Conversation
    lists, conversation pages and every run stall until it commits.

On deployments with large event logs, run the upgrade off-peak and estimate the duration from the
table sizes first:

```sql
SELECT pg_size_pretty(pg_relation_size('capybara.conversation_events')) AS events,
       pg_size_pretty(pg_relation_size('capybara.conversations')) AS conversations;
```

### 0.1.0: IM long connections move to the gateway role

IM long connections (Slack Socket Mode, Lark long connection) now run **only on processes with the
`gateway` role**. Before, they ran on `worker`.

- `capybara start` without roles, and the all-in-one default, still include `gateway`.
- If you set `CAPYBARA_ROLES` yourself (for example `api,worker` or `worker`), add `gateway` to at least
  one process that can load your channel plugins, or channels stop receiving messages.
- Outbound delivery and inbound processing still need `worker`.
- At startup, a process with `worker` but not `gateway` logs an info line. A worker job warns every
  minute while active channel connections have no live gateway replica. See
  [Roles and scaling](README.md#roles-and-scaling).
- New settings: `channels.shareSlack` (fair share across gateway replicas), and
  `channels.webhookBaseUrl` / `channels.webhookMaxBodyBytes` (optional webhook inbound). Migration
  0038 adds `inbound_mode` to channel connections. Existing connections stay on `long_connection`.
- Migration 0039 lets a channel card be recorded before it is sent (`message_id` may be NULL while a
  card is pending). Replicas older than 0.1.0 don't expect that: during a rolling update, an old
  replica that handles the update of such a card fails and retries it until the event is skipped. To
  avoid it, stop the old `worker` replicas before starting the new ones (or accept that a card update
  may be lost while both versions run).

### 0.1.0: the official catalog is off by default

`catalogs.official.enabled` now defaults to `false`, because the official catalog isn't live yet. The
kernel no longer fetches it, and the admin console's directory shows it as offline. Enterprise
catalogs, npm installs and manual uploads are unaffected. Once the official catalog is live, set
`CAPYBARA_CATALOGS__OFFICIAL__ENABLED=true` to use it.

### Moving config-declared plugins to install records

Plugins listed in the startup config's `plugins` (`CAPYBARA_PLUGINS`) still load. Their source is
`config`. But the admin console shows them read-only: they can't be installed, upgraded or disabled
there, changing the list needs a restart, and installing a plugin with the same name returns 409
`plugin.config_declared`. The kernel doesn't convert them automatically. To move one:

1. Get a package of the **same npm package**: a version from npm, or `pnpm pack-plugin plugins/<name>`
   from a checkout. A plugin name belongs to the npm package that first used it, and a different
   package name is refused (`plugin.name_conflict`).
2. Remove it from `plugins` and do a rolling restart. The plugin stops loading. Plugins that depend on
   it unload too and show `dependency`, and they reload once it is back.
   - Its deployment config in `pluginConfig` can stay and still applies. You can also move it to the
     admin console.
3. Install the package (admin console, or `capybara plugins install …`) and enable it. The plugin
   schema, secrets, org config and approval record carry over. If the new package asks for no
   permissions beyond the approved ones, it loads right away.
