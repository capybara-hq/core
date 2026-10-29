---
name: writing-migrations
description: 'Use when adding or changing a SQL migration in core (kernel packages/kernel/src/migrations, or the migrations of plugins/model-fake and the fake extensions of @capybara-hq/testing): file naming, applied migrations are immutable, the schema each file runs in, idempotent style, the expand-then-contract two-step column drop, the exemption comment and reason required for destructive statements, and how to run capybara migrate locally. For an official plugin''s migrations see writing-migrations in capybara-hq/plugins.'
---

# Writing migrations

Migrations are plain SQL files. `pnpm check:migrations` (also part of `pnpm check`) checks them statement by statement; the rule ids in the table below are the ids it reports. The rules are those of `capybara-plugin check` (`@capybara-hq/plugin-tools`), so an extension's migrations follow the same table; writing an official plugin's migrations is covered by [writing-migrations in capybara-hq/plugins](https://github.com/capybara-hq/plugins/tree/main/.agents/skills/writing-migrations).

## Naming

`NNNN_<snake_desc>.sql`: four digits, then lower-case letters / digits / underscores; files run in numeric order. Example: `0002_add_label.sql`. A non-conforming name reports `naming`.

**Applied migrations are immutable.** Never edit, delete or rename a migration file once it is on `main`; add a new one instead. The migrator records each file by name and checksum, so an edited file stops `capybara migrate` (checksum mismatch) on every database that already ran it, while fresh test databases pass. On pull requests `pnpm check:applied-migrations --base <base>` fails when the diff modifies, deletes or renames an existing file under `packages/kernel/src/migrations/` or `plugins/*/migrations/` (rule `applied-migration-edited`); adding files is fine, and so is deleting a whole plugin with its migrations (its `.capybara-plugin/plugin.json` deleted in the same diff: the plugin moved to another repository). Run it locally with `--base origin/main`.

Location: kernel `packages/kernel/src/migrations/` (schema `capybara`); extension `<plugin>/migrations/` (schema `plugin_<name>`, with `-` replaced by `_`). In core the extension ones are `plugins/model-fake` (none today) and the fake extensions under `packages/testing/fixtures/extensions/*/migrations/`; the official plugins' migrations live in capybara-hq/plugins.

## Which schema a migration runs in

The migrator wraps each file in a transaction and runs `set local search_path to <that schema>, public`. So **table names carry no schema prefix**.

**Transactions and locks.** A migration file is plain SQL run by the migrator, not kernel code: the kernel's `@Transactional` / `KernelDb` conventions (`.agents/skills/writing-kernel-api`) do not reach it, and it must not control transactions itself (rule `transaction-control` below). The migrator runs on its own `pg` client and holds a session-level `pg_advisory_lock` per schema (`capybara-migrate:<schema>`; extensions: `capybara.plugin-migrate:<name>`, `extensions/migrate-lock.ts`) while it applies files, so concurrent migrators (an init Job, starting replicas) wait instead of running twice. These two runners are the only session-level advisory locks the kernel keeps (listed exceptions of `kc-lock` in `check:kernel-conventions`); kernel code serializes with `FOR UPDATE`, a `*Lock` provider over `pg_advisory_xact_lock` (ruling R9) or `LockService`. Note that `public` comes second: a name not found in this schema resolves to the same-named object in `public`, so do not depend on anything in `public`, and do not give a table the same name as an existing object in `public`.

```sql
CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now()
);
```

## Rules

| Rule | Description | Rule id |
|---|---|---|
| Creating objects takes `IF NOT EXISTS` | `CREATE TABLE / INDEX / SCHEMA / EXTENSION / SEQUENCE` | `idempotent` |
| Dropping objects takes `IF EXISTS` | `DROP TABLE / INDEX / ...`, `DROP COLUMN IF EXISTS`, `DROP CONSTRAINT IF EXISTS` | `idempotent` |
| No transaction control | No `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT`; no `CREATE INDEX CONCURRENTLY` (it cannot run inside a transaction; use a plain `CREATE INDEX IF NOT EXISTS`) | `transaction-control` |
| Avoid `DO` blocks where possible | The statements inside cannot be reviewed statically; split into ordinary idempotent statements when you can. When one is really needed (for example `RENAME COLUMN` has no `IF EXISTS`, so it has to go inside `IF EXISTS (SELECT … information_schema.columns …) THEN … END IF` to be idempotent), write the exemption comment **directly above** the `DO` line, see below | `do-block` |
| Destructive statements need an exemption | See below | `destructive` |

Destructive statements = dropping a column, `DROP TABLE` / `DROP SCHEMA`, `TRUNCATE`, `DELETE FROM`, anything containing `RENAME`, and changing a column type (`ALTER COLUMN ... TYPE`). The check also scans the body of `DO $$ … $$` blocks: if the body has such statements and there is no exemption comment above the `DO` line, it reports `destructive` in addition to `do-block`. A comment written inside the `$$` does not count. Statements assembled with `EXECUTE` inside a block body are invisible to the check, so for a `DO` block carrying an exemption comment the reason is required whether or not the body was recognized as destructive.

```sql
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS apps RENAME TO connectors;
-- capybara:allow-destructive column rename; code is renamed in the same release (project not released, no compatibility layer)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'capybara' AND table_name = 'connector_tools' AND column_name = 'app_id') THEN
    ALTER TABLE connector_tools RENAME COLUMN app_id TO connector_id;
  END IF;
END
$$;
```

## Expand -> contract (two-step column drop)

During a multi-replica rolling release, old and new versions of the code are online at the same time, so you **cannot both stop using a column and drop it in one version**.

Version N (expand): add the new column, change the code to read and write the new column; the old column is no longer used but is kept.

```sql
-- 0002_add_label.sql
ALTER TABLE events ADD COLUMN IF NOT EXISTS label text;
```

Version N+1 (contract): after confirming that no running version still reads or writes the old column, drop it.

```sql
-- 0003_drop_old_name.sql
-- capybara:allow-destructive since 0002 all code reads label instead; no version reads or writes old_name any more
ALTER TABLE events DROP COLUMN IF EXISTS old_name;
```

## Exemption comment

- Form: `-- capybara:allow-destructive <reason>`; it must be on the line **immediately above** the destructive statement (or the `DO` line of a `DO` block), with no blank line or other comment in between.
- **The reason cannot be empty**, and should explain why this version may run the statement directly (for example "this table is new in this version and has no data yet", "reads and writes stopped in the previous version"). A marker with an empty reason still reports `destructive`.
- Writing a destructive statement with no marker reports `destructive`.

## Running locally

```bash
docker compose -f docker/compose.dev.yaml up -d      # postgres + valkey
export CAPYBARA_DB__URL=postgres://capybara:capybara@localhost:5432/capybara
export CAPYBARA_REDIS__URL=redis://localhost:6379
export CAPYBARA_MASTER_KEY=$(openssl rand -base64 32)
export CAPYBARA_EXTENSIONS='["<extension package>"]'   # which config-declared extensions to migrate (optional)
pnpm capybara migrate
```

`capybara migrate` migrates the kernel first, then, in dependency order, the extensions listed in `CAPYBARA_EXTENSIONS` that declare `migrations`, and then exits; files already applied are not run again. Check: `pnpm check:migrations`.
