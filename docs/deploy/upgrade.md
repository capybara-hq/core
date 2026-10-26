# Upgrading Capybara

Read the release notes of every version between yours and the target first. While Capybara is on
0.x, the plugin SDK and the HTTP API may change in breaking ways, and the release notes say how to
migrate.

## How an upgrade runs

1. **Pull the new images first.**
2. **Migrate and bootstrap.** Run `capybara migrate`, then `capybara bootstrap` (the compose `init`
   container does both, or a Kubernetes Job) and wait for it to finish. The bootstrap step installs or
   upgrades the plugins the new image pins (see
   [Bootstrap plugins](README.md#extensions)); it does nothing when the manifest didn't change.
3. **Roll `api`, `worker` and `gateway`** (and `web`) onto the new version.

Kernel migrations are normally expand-only and forward compatible by one version: the previous
version's code keeps working on the migrated schema, so old and new replicas can run side by side
during a rolling update. When you skip versions, old replicas may run against a schema two or more
versions ahead of them. In that case, stop them before migrating, or accept errors on them until they
are replaced. A version note below says when a release breaks this rule and can't be rolled; the
rename in 0.1.0 (migrations 0041 to 0043) is one.

Extension upgrades need no restart and are separate from kernel upgrades. Install the new version from
the admin console or with `capybara extensions install`. See
[.agents/skills/writing-extensions](../../.agents/skills/writing-extensions/SKILL.md).

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

`init` runs on every `up`, re-applies migrations and runs the bootstrap step. If it fails, compose doesn't start the new `api`,
`worker` and `gateway`: read `docker compose logs init`.

### Kubernetes

Run the migrate Job (`capybara migrate`, then `capybara bootstrap`) with the new `capybara-api` image,
wait for it to complete, then update the Deployments. Kernel replicas also apply pending kernel migrations at startup, under the same advisory
lock, so a replica that starts before the Job finishes is serialized with it rather than racing it.
Only `capybara migrate` checks the PostgreSQL version, though, so keep the Job.

## Migration locking

- Kernel migrations take a session-level advisory lock (`capybara-migrate:capybara`) for the whole
  run. Concurrent migrators (the Job, `init`, starting replicas) wait for it instead of running twice.
  Extension schemas have their own lock.
- **Each migration file runs in its own transaction.** A failure rolls back that file and stops the
  run. The files before it stay applied, and the next run continues from the failed file.
- Kernel migrations set **no `lock_timeout` and no `statement_timeout`**. A migration that needs a
  lock held by a long-running transaction waits for it. While it waits, its own lock request queues
  ahead of new readers and writers of that table, so the table stalls. Before upgrading, check for
  long transactions in `pg_stat_activity`.
- Extension migrations run by an install or upgrade at runtime are bounded by
  `extensionHost.migrationTimeoutSeconds` (default 300). That bound sets `statement_timeout` and a
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

### Upgrading across 0040 (index build and table lock)

Migration `0040_usage_report_sweep.sql` builds `conversation_events_usage_idx`, a partial index on
`conversation_events (created_at) WHERE type = 'usage'`, **non-concurrently inside the migration
transaction** (the same class of note as 0027 / 0028 above). A plain `CREATE INDEX` blocks **writes**
to `conversation_events` until it finishes: new messages and agent runs stall, reads continue. It also
creates the small `usage_report_sweep` table. This only matters for deployments that ran `main`
before 0.1.0 and have large event logs; run the upgrade off-peak and estimate from the size query
above. New installs migrate an empty table.

### 0.1.0: IM long connections move to the gateway role

IM long connections (Slack Socket Mode, Lark long connection) now run **only on processes with the
`gateway` role**. Before, they ran on `worker`.

- `capybara start` without roles, and the all-in-one default, still include `gateway`.
- If you set `CAPYBARA_ROLES` yourself (for example `api,worker` or `worker`), add `gateway` to at least
  one process that can load your channel extensions, or channels stop receiving messages.
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

### 0.1.0: extensions, plugins, catalog and marketplaces (renamed)

This only matters for deployments that ran `main` before 0.1.0. The in-process code that used to be
called a plugin is now an **extension**; a **plugin** is now the install unit (formerly an app
bundle); the enterprise directory is the **catalog**; catalog sources are **marketplaces**. Migrations
0041 to 0043 rename the tables and keep their rows. Rename these settings yourself, because the old
names are ignored:

- `plugins` / `CAPYBARA_PLUGINS` -> `extensions` / `CAPYBARA_EXTENSIONS`; `pluginConfig` /
  `CAPYBARA_PLUGIN_CONFIG` -> `extensionConfig` / `CAPYBARA_EXTENSION_CONFIG`; `pluginHost.*` ->
  `extensionHost.*`; `pluginPermissions.*` -> `extensionPermissions.*`.
- `catalogs.*` -> `marketplaces.*`; `directory.staleInstallMinutes` -> `catalog.staleInstallMinutes`;
  `directory.maxBundleBytes` is gone (see the package format note below: plugins no longer fetch
  extension packages at import, so there is nothing to cap).
- The CLI's `capybara plugins …` is now `capybara extensions …`; HTTP routes, error codes and audit
  actions follow the new names (audit rows written before keep their old names). `capybara plugins`
  now has `list` and `import`, which manage the catalog.

**This step is not a rolling update.** Migrations 0041 to 0043 are not expand-only: they rename
tables and rewrite CHECK values, and the kernel HTTP routes are renamed with them. Replicas of the
earlier build fail right after the migration (their tables are gone), and an earlier `web` calls
routes that no longer exist. So stop every replica of the earlier build (`api`, `worker`, `gateway`
and `web`) before running `capybara migrate`, then start the new version. Redis and queue state carry
over: job ids and bus topics are unchanged.

### 0.1.0: the plugin package format

This only matters for deployments that ran `main` before 0.1.0. Packages are now plugins: an npm-pack
tgz with `.capybara-plugin/plugin.json` (at most one extension, skills, connector templates as
`connectors/<id>.json`, dependencies on other plugins). Marketplaces publish `marketplace.json`
instead of `index.json`. The earlier formats (a `capybara` section in `package.json`, and app
bundles) are not read any more, and there is no converter:

- **Catalog content is removed.** Migration 0044 deletes every catalog item and version, plugin
  install record, catalog request and grant, staged import and marketplace entry, because they were
  imported in the earlier format (marketplace entries come back at the next refresh, once the
  marketplace publishes `marketplace.json`). It also drops the catalog policies and grants that restricted extensions, so admins re-import the plugins and set their policies again. Org skills, connectors and deployment extension installs
  stay; they only lose their link to the removed catalog item. Files the earlier catalog stored under
  `deployment/directory/` in object storage are left in place, unreferenced; delete them by hand if
  you want the space back. Re-import the plugins you need, repacked.
- **Installed extension packages need a repack.** An extension installed from an earlier-format
  package stays installed, but no replica loads it: the admin console shows it as "Repack needed"
  (`legacy_format`) with the reason, and approving it returns `extension.legacy_format`. Reinstall it
  from a tgz repacked with `capybara-plugin pack` (same npm package, so its data, secrets, config and
  approval carry over). `openai-compatible` and `object-store-s3` come from the image as bootstrap plugins and are
  unaffected.
- **Uploads in the earlier format are refused** with `catalog.legacy_format` or
  `extension.legacy_format` and a message asking to repack the package. The catalog no longer
  takes zip uploads of skills or connector templates; package them as a plugin (an org can still
  upload a skill zip under Skills).
- **Routes changed** (the web app follows): plugin import is `POST /api/v1/admin/catalog/import/file`
  or `…/import/npm`, then `POST …/catalog/imports/:stagingId/confirm`; the `kind` parameters are gone;
  an org install takes `{ version?, connectors?, extensionConfig? }`.

Migrations 0044 and 0045 run as part of the same stop-and-migrate step as 0041 to 0043.

### 0.1.0: the official marketplace is off by default

`marketplaces.official.enabled` now defaults to `false`, because the official marketplace isn't live yet. The
kernel no longer fetches it, and the admin console's marketplaces page shows it as offline. Enterprise
marketplaces, npm installs and manual uploads are unaffected. Once the official marketplace is live, set
`CAPYBARA_MARKETPLACES__OFFICIAL__ENABLED=true` to use it.

The default `marketplaces.official.url` is now the git repository
`https://github.com/capybara-hq/plugins.git` (it was a placeholder marketplace.json URL). A git
marketplace has no mirrors: if you set `marketplaces.official.mirrors`, either also set
`marketplaces.official.url` to a marketplace.json URL or remove the mirrors (point the URL at a mirror
repository instead); otherwise the kernel refuses the config at start.

### Git marketplaces, private addresses and plugin upgrades (migrations 0046 to 0049)

Migrations 0046 to 0049 are expand-only, so this step rolls like any other:

- 0046 adds the marketplace form (`http` / `git`), its ref, last commit and owner name, a `git`
  source with `source_detail` and a content digest on catalog versions, and lets
  `catalog_items.package_name` be NULL (a git plugin without `package.json`).
- 0047 and 0048 record the branch head and the plugin directory's git tree of marketplace entries,
  for "content changed at the same version".
- 0049 adds the `upgrading` install status, the upgrade journal on `plugin_installs`, and
  `template_id` / `dropped` on install components. It drops and re-adds the status CHECK of
  `plugin_installs` in one transaction, a short lock on a small table.

Versions imported before this step have no content digest or source detail. They are compared by
integrity when both sides have one, and show no origin in the admin console. Connectors installed
before 0049 have no `template_id`, so an org upgrade leaves them as they are; the upgrade preview
says so.

**Private addresses are now refused for every marketplace download.** Manifests, mirrors, archive
sources and git repositories must resolve to public addresses, and the connection is pinned to the
address that was checked. A marketplace or mirror that used to work on a private network (an internal
GitLab, an artifact server) now fails its refresh or import with `marketplace.private_address`. Add
its host to `marketplaces.allowPrivateHosts`:

```bash
CAPYBARA_MARKETPLACES__ALLOW_PRIVATE_HOSTS='["gitlab.corp.example","10.20.0.0/16"]'
```

List a host reached by an internal DNS name **by name**. IP addresses and CIDRs match only URLs that
use an IP literal, never a DNS name that resolves into the range. Link-local and cloud metadata
addresses are always refused. The `packages.npmRegistry` origin is trusted as configured and needs no
entry. Redirects were already refused; they now fail with `marketplace.redirect`.

New settings: `marketplaces.allowPrivateHosts` and `marketplaces.allowedHosts` (default `[]`,
unrestricted: the hosts that marketplace entries may download git and archive sources from). See
[docs/config.md](../config.md) and [Plugins and the catalog](README.md#plugins-and-the-catalog).

### Bootstrap plugins replace the built-in extensions (migration 0050)

`openai-compatible` and `object-store-s3` are no longer built into the CLI. They are bootstrap plugins:
pinned in `packages/kernel/bootstrap.json`, baked into the kernel images under `/app/bootstrap`, and
installed by `capybara bootstrap`, which compose's `init` runs after `migrate` (see
[Bootstrap plugins](README.md#extensions)). Both are required: enabled in every organization and not
disableable or uninstallable (409 `extension.required`, which replaces `extension.builtin`).

Migration 0050:

- adds the source `bootstrap` to extension packages, install records, permission snapshots and
  catalog versions, the column `extension_installs.required`, and the table `bootstrap_runs` (one row
  per manifest the bootstrap step completed);
- deletes the replica status rows with source `builtin` and drops `builtin` from that table's CHECK.
  Each replica rebuilds its rows on its next reconcile. A replica of the previous version can no
  longer record the status of its built-in extensions (the CHECK refuses the row and it logs
  `cannot write plugin replica status`; the extensions still load), so replace the old replicas
  promptly after migrating.

**Deployments that ran a development build before this step** (their built-in extensions had no
install records) lose nothing: the first bootstrap run installs both plugins with source `bootstrap`
under the names they already own. Their deployment config (startup config or the one saved in the
admin console) still applies, organizations keep them enabled, and their data is kept. After the
upgrade `capybara extensions list` shows them with source `bootstrap` and state `required`. The first
release, 0.1.0, already ships with bootstrap, so a deployment that starts on 0.1.0 never had built-in
extensions.

**Rolling back** to an image with an older bootstrap manifest changes nothing: that manifest's run is
already recorded as done, so the step doesn't run again (no downgrade, and a `required` flag a newer
manifest cleared is not restored).

**Running from a source checkout** (`pnpm capybara start`) skips the bootstrap step: config-declared
extensions are the development path. To try it, pack the pinned plugins and point the kernel at them:

```bash
pnpm pack-bootstrap --out artifacts/bootstrap
pnpm capybara bootstrap --dir artifacts/bootstrap   # or: pnpm capybara start --bootstrap-dir artifacts/bootstrap
```

**For contributors:** a change to a pinned plugin, to its dependencies (the lockfile) or to
`packages/plugin-tools` changes the pack, so `pnpm check` fails with `bootstrap-stale`. Run
`pnpm check:bootstrap --write` to rewrite the pinned version and integrity, and commit the result.
`pnpm version-packages` (the Version Packages PR) does this itself after `changeset version`.

New settings: `net.httpsProxy` and `net.noProxy` send marketplace, mirror, archive and git downloads
through an HTTP(S) egress proxy (see [Plugins and the catalog](README.md#plugins-and-the-catalog)).
They are unset by default; nothing changes for a deployment that doesn't set them.

### Moving config-declared extensions to install records

Extensions listed in the startup config's `extensions` (`CAPYBARA_EXTENSIONS`) still load. Their source is
`config`. But the admin console shows them read-only: they can't be installed, upgraded or disabled
there, changing the list needs a restart, and installing an extension with the same name returns 409
`extension.config_declared`. The kernel doesn't convert them automatically. To move one:

1. Get a package of the **same npm package**: a version from npm, or `capybara-plugin pack <dir>`
   (`pnpm pack-plugin plugins/<name>` in a core checkout) from a checkout. An extension name belongs to the npm package that first used it, and a different
   package name is refused (`extension.name_conflict`).
2. Remove it from `extensions` and do a rolling restart. The extension stops loading. Extensions that depend on
   it unload too and show `dependency`, and they reload once it is back.
   - Its deployment config in `extensionConfig` can stay and still applies. You can also move it to the
     admin console.
3. Install the package (admin console, or `capybara extensions install …`) and enable it. The extension
   schema, secrets, org config and approval record carry over. If the new package asks for no
   permissions beyond the approved ones, it loads right away.
