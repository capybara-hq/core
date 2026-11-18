# Upgrading Capybara

Read the release notes of every version between yours and the target first. While Capybara is on
0.x, the plugin SDK and the HTTP API may change in breaking ways, and the release notes say how to
migrate.

## How an upgrade runs

1. **Pull the new images first.**
2. **Migrate and bootstrap.** Run `capybara migrate`, then `capybara bootstrap` (the compose `init`
   container does both, or a Kubernetes Job; `capybara bootstrap` needs Redis as well as PostgreSQL)
   and wait for it to finish. The bootstrap step installs or
   upgrades the plugins the new image pins, downloading them from npm or taking them from the
   offline directory (see [Bootstrap plugins](README.md#extensions)); it does nothing when the
   manifest didn't change.
3. **Roll `api`, `worker` and `gateway`** (and `web`) onto the new version.

Kernel migrations are normally expand-only and forward compatible by one version: the previous
version's code keeps working on the migrated schema, so old and new replicas can run side by side
during a rolling update. When you skip versions, old replicas may run against a schema two or more
versions ahead of them. In that case, stop them before migrating, or accept errors on them until they
are replaced. A version note below says when a release breaks this rule and can't be rolled.

Extension upgrades need no restart and are separate from kernel upgrades. Install the new version from
the admin console or with `capybara extensions install`. See
[.agents/skills/writing-extensions](../../.agents/skills/writing-extensions/SKILL.md).

### Permission configuration rollout

`sandbox.limits.egress`, `orgHosts` and `allowHosts` require restart. `devices.fullAccess` remains hot;
watching a mixed hot/restart payload publishes only the locally effective network plus the new hot
value. Watching a restart-only change never activates it.

1. Prepare the intended source and environment. On a mismatch, inspect the nonsecret `activeHash`
   and `candidateHash` diagnostic. A normal stale restart changes no authority.
2. Start one replica with `capybara start --activate-permission-config <expected-active-hash>`.
   The candidate is that process's validated startup configuration. If another writer won first,
   the command fails before extensions or roles start; review the new active hash before retrying.
   An empty deployment must first start normally, without the activation flag.
3. Roll the remaining replicas onto the same configuration. Old replicas immediately fail future
   permission admission after activation; matching replicas continue. Revocation obligations and
   semantic permission revisions commit together, without waiting for provider calls.

A committed activation survives a subsequent bootstrap/start failure. Retry the same candidate and
expected hash: an already-active candidate is a no-op, including after a lost commit acknowledgment.
An uncertain transaction diagnostic is not proof of rollback. To intentionally restore an earlier
configuration, start it with the **current** active hash. Applicable semantic revisions advance again;
old Full consent is not restored, and users must renew consent when its scope changed.

Startup activation uses a private PostgreSQL session: a 30-second absolute work limit, session
statement/lock/idle-transaction timeouts of 500 ms, and at most 1,500 ms cleanup within startup shutdown
drain. Contention or slow scans may require a deliberate retry. Protocol cancellation needs no SQL
backend-signaling privilege; server or network failure may leave the remote commit outcome uncertain.
These bounds do not change ordinary hot publication or migration timeouts.

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

Notes for upgrades that need more than the steps above. Before 0.1.0 Capybara keeps no
compatibility layers for its earlier builds: the kernel reads only the current formats, and the
migrations rewrite stored data once where they can.

### Upgrading across 0130 / 0131 (auto mode): stop the old replicas first

Auto mode replaces the sandbox tiers. `0130_auto_mode.sql` drops `devices.tier` and deletes the
`deployment_settings.sandboxTiers` row; `0131_device_mode.sql` adds `devices.mode`.

**This step is not a rolling update.** A deployment that runs more than one replica must drain or
stop every old replica (`api`, `worker`, `gateway` and `web`) before applying the migration set: old
code still reads the removed `devices.tier` column and the `sandboxTiers` setting, so after the
migration its device queries fail and its settings read as the new default (auto mode allowed) until
every replica runs the new build. Stop the old replicas, run `capybara migrate` (and
`capybara bootstrap`), then start the new version.

**Check the auto mode settings after the upgrade.** 0130 maps the stored tiers by their `max`
only: the platform's `sandboxTiers` with `max: "open"` or no `max` becomes `devicesAutoMode:
allowed`, anything lower `off`; an org's `sandboxTier` with `max: "open"` becomes `autoMode:
allowed`, any other stored `sandboxTier` `off`. `allowUnsandboxed` is not read, and the source keys
are deleted, so no later migration can recover it. If you set `allowUnsandboxed: false` (open
egress, but no command outside the sandbox), auto mode is now allowed where you had kept the
sandbox on: after upgrading, turn Full access off for those orgs (org settings, `fullAccess: off`)
or for the platform (`devices.fullAccess: off`, or the admin console; the old names `autoMode` and
`devices.autoMode` are refused now: rename them, or convert a config file with
`capybara config migrate-permissions`). Leftover `sandbox.tiers`,
`sandbox.limits.devHosts` or `sandbox.limits.egress: "open"` in the config file, Nacos or the
environment now stop the kernel at startup with an error naming `devices.fullAccess` and
`cloudNetwork`: remove them and set those instead.

### Org sandbox networks follow the platform (migration 0134)

An organization's sandbox network no longer replaces the platform's `sandbox.limits.allowHosts`
with a copy. It stores what it adds and drops (spec
`docs/superpowers/specs/2026-11-15-org-egress-ceiling-design.md`), so a change to the platform list
reaches every organization that follows it. Approving a network request adds only the requested
hosts.

- **Migration 0134 keeps every organization's current list exactly.** An organization that had its
  own list (including the copy an earlier approval made) keeps it, as "only these hosts"; it does
  not pick up later platform changes until an org admin chooses 「跟随平台」 (follow the platform)
  in the sandbox settings.
- **Rolling upgrade.** An old replica still running after 0134 may write the old shape when it
  approves a network request or saves the sandbox settings; the new kernel reads that value as an
  empty allowlist (never wider). Avoid org network edits and approvals during the rollout, or re-save
  the organization's network afterwards.
- **A ceiling for the super admin.** `sandbox.limits.orgHosts: within`
  (`CAPYBARA_SANDBOX__LIMITS__ORG_HOSTS`) makes `allowHosts` the ceiling: organizations cannot add
  other hosts or use the open cloud network in sandbox mode, and their admins cannot approve network
  requests for hosts outside it. Full access is not limited by it: set `devices.fullAccess: off` as
  well for a hard ceiling (startup warns otherwise). The default `extend` keeps today's behaviour.

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
