# Bootstrap extra manifest: distributions on the upstream image

Issue: #450. Status: draft for review.

## Why

A distribution is a branded, self-hosted package of Capybara that runs the upstream images
unchanged and adds its own plugins, look and defaults. Today it cannot do that without forking
core:

- the bootstrap manifest is `packages/kernel/bootstrap.json`, inside the kernel package; no config
  field points at another one (`createKernelApp` takes `bootstrapManifest`, but only tests pass it);
- a second marketplace can only be added by a super admin in the admin UI, after the first start;
- the platform default theme is chosen by a super admin, so the first pages of a fresh deployment
  (`/setup`, sign-in) always show the built-in theme;
- a private git marketplace on a host other than GitHub cannot be read: the token is always sent as
  HTTP Basic `x-access-token:<token>` (`catalog/git-source.ts:180`).

Success: a distribution ships one JSON file and a few config values; the first page a fresh
deployment serves already shows its theme, its plugins are installed and pinned like the built-in
ones, its marketplace is listed for upgrades, and upgrading Capybara is bumping the image version.

## Goals

1. `bootstrap.extraManifest`: a second manifest, **merged with** the built-in one, never replacing
   it.
2. Extra entries pinned and verified like built-in ones, from npm or from a git marketplace (a
   repository whose plugins are `path` entries), with the offline directory still working.
3. Marketplaces registered at startup, owned by the config (read-only in the admin UI).
4. A default platform theme applied while nobody has saved the platform theme, and never over a
   person's choice. (No released deployment exists before 0.1.0, so there is no "running deployment
   that later adds an extra manifest" case to treat differently.)
5. Git marketplace credentials that work on any host: a username plus a token.

## Non-goals

- Overriding or removing built-in entries (an extra manifest only adds).
- Product-name strings (#452) and theme coverage of every graphic and page (#451).
- A CI check for a distribution's manifest inside core; distributions validate with
  `capybara-plugin` (see Tooling).
- SSH git access.

## Approaches

| | What | Trade-off |
|---|---|---|
| **A. Config fields only** | `marketplaces.extra[]`, `ui.defaultTheme` with a plugin pin | A second install path beside bootstrap: integrity pinning, offline install, two passes and retry would be rebuilt |
| **B. Extra manifest, merged** (chosen) | `bootstrap.extraManifest` → a file merged into the built-in manifest before the run | Reuses every bootstrap guarantee; the manifest format grows two fields and one entry kind |
| C. Replace the manifest | `bootstrap.manifest` → a full copy | Simplest code, but every distribution re-syncs upstream pins on each upgrade; a stale copy silently skips a new required plugin |

## Design

### 1. Config

```yaml
bootstrap:
  dir: bootstrap                 # unchanged
  extraManifest: null            # path, resolved against the working directory like `dir`
marketplaces:
  tokens: {}                     # name -> token for marketplaces the extra manifest declares (secret)
```

- `bootstrap.extraManifest` (env `CAPYBARA_BOOTSTRAP__EXTRA_MANIFEST`): not hot (read at bootstrap
  and at start). Absent = today's behaviour exactly.
- `marketplaces.tokens` (env `CAPYBARA_MARKETPLACES__TOKENS` as JSON, or per key in Nacos):
  `secret`, not hot. Tokens never go in the manifest file, which is meant to be committed.
- `docs/config.md` regenerated.

### 2. The extra manifest (`bootstrap-extra.v1`)

```jsonc
{
  "$schema": "https://capybarahq.com/schemas/bootstrap-extra.v1.schema.json",
  "schemaVersion": 1,
  "marketplaces": [
    { "name": "acme", "url": "https://git.example.com/acme/plugins.git", "username": "x-token-auth" }
  ],
  "plugins": [
    { "name": "theme-acme", "source": "git", "marketplace": "acme",
      "commit": "<40 hex>", "path": "./plugins/theme-acme",
      "version": "0.1.1", "integrity": "sha512-…", "builtin": true },
    { "name": "acme-tools", "source": "npm", "npm": "@acme/plugin-tools",
      "version": "1.2.0", "integrity": "sha512-…", "required": false }
  ],
  "defaultTheme": { "plugin": "theme-acme", "theme": "acme" }
}
```

- SDK: `BootstrapExtraManifestSchema` and `parseBootstrapExtraManifest` in
  `packages/plugin-sdk/src/bootstrap.ts`, beside the built-in ones; strict objects; JSON Schema
  generated into `schemas/bootstrap-extra.v1.schema.json` and registered in `PACKAGE_SCHEMAS`.
- `required` is optional here (default `false`); `required` and `builtin` keep their meaning and
  stay exclusive.
- `marketplaces[]`: `name` (`^[a-z0-9][a-z0-9-]{0,63}$`, unique, not `official`), `url` (the same
  rules as an admin-added marketplace: https, no userinfo, through `packages/kernel/src/net`),
  optional `ref` / `username` (`^[A-Za-z0-9._-]{1,64}$`).
- `defaultTheme`: `{ plugin, theme }`, where `plugin` names an entry of this manifest with
  `builtin: true` and `theme` is a theme file id of that plugin. A theme from a non-builtin entry is
  refused at parse time: only a builtin plugin is on in every org, which a platform default needs.

### 3. Merge

The kernel and `capybara bootstrap` build **one** manifest: built-in entries first, then extra
entries. Parse errors in either file fail the step, as an invalid built-in manifest does today.

- A name present in both fails the step (`bootstrap.extra_conflict`): an extra manifest never
  overrides an upstream pin.
- The run identity becomes the sha256 of the merged manifest, so `bootstrap_runs`, `isDone`,
  `lastRunNames` and `clearRemoved` work unchanged: an extra entry dropped from the file is treated
  exactly like a built-in entry dropped by an upgrade.
- `clearRemoved` already acts on "every live platform item not in the manifest"; with the merged
  manifest it no longer strips the other file's entries (running the files separately would).

### 4. Git entries

A new entry kind `source: "git"`, accepted only in the extra manifest:

| Field | Meaning |
|---|---|
| `marketplace` | a name from this file's `marketplaces[]` (gives the URL and credentials) |
| `commit` | 40-hex commit the tree is read at (never a branch) |
| `path` | the plugin directory inside the repository (`./…`, or `.` / `./` for the root of a single-plugin repository) |
| `integrity` | sha512 of the **kernel's** canonical pack of that tree (`packPackageTgz`: sorted paths, mode 0644, mtime 0, `package/` prefix) |

**One integrity, one packer.** The kernel already packs a git tree with `packPackageTgz`
(`packages/tgz.ts`) when an admin imports a git or path source; `capybara-plugin pack` bundles from
source with esbuild and gives other bytes. A `git` entry's `integrity` is therefore defined on the
kernel's pack, and `capybara-plugin` computes it with the same exported function
(`@capybara-hq/plugin-tools` already depends on the kernel). Obtaining the package, in order:

1. **Offline directory:** a `*.tgz` whose sha512 equals `integrity` is used, as for npm entries
   (`capybara-plugin bootstrap --write` produces exactly that file).
2. **Git:** read the tree at `commit` with `readGitTree` (token and username of the marketplace,
   sent only to its origin), pack it with `packPackageTgz`, and refuse it unless its sha512 equals
   `integrity` (`bootstrap.integrity_mismatch`, as for npm).

Either path is thus verified against the same recorded value. What the tree must contain is the
admin git import's rule, unchanged: a declarative plugin needs only its files; a plugin with an
extension needs its `package.json` and built output committed (`plugin-import.ts:782-796`).

**Source identity.** The catalog must see a `git` entry exactly as an admin import of the same
marketplace entry, so that later upgrades from the managed marketplace match
(`assertSameSource`, `sourceIdentity`). The import source is
`{ kind: "bootstrap", ref, integrity, detail }` with `detail`
the `GitSourceDetail` that `importFromMarketplace` builds for a `path` entry (host and repo from the
marketplace URL, `path`, `commit`, `followsBranch: true`, as for an admin import of a `path`
entry), whichever of the two ways the bytes came. The run still records the entry under
`bootstrap:<name>@<version>` in `bootstrap_runs`.

The git read needs no marketplace row and no prior refresh, so it works in `capybara bootstrap`,
which runs before any kernel start (compose `init`). The import names the managed marketplace on
the item only when its row exists; otherwise the next kernel start's sync fills it in (R13 in "As
built": `syncExtraFromConfig` backfills `catalog_items.marketplace_id`).

### 5. Marketplaces owned by the config

At start, beside `syncOfficialFromConfig`, `syncExtraFromConfig` upserts one row per
`marketplaces[]` entry:

- new column `marketplaces.managed text NULL` (`'config'` for these rows; migration
  `NNNN_marketplace_managed.sql`, expand-only), id `config:<name>`;
- URL, ref and username follow the file; the token comes from `marketplaces.tokens[name]` and is
  kept out of the secrets table;
- like the official row, a managed row refuses edits and deletion except `enabled`
  (`marketplace.config_managed`), and the sources page shows it read-only with "configured by the
  deployment";
- a row whose name left the file is kept, marked `managed = NULL`, and becomes an ordinary custom
  marketplace without a token (no silent deletion of what admins may have imported from).

`capybara bootstrap` does not write marketplace rows; the kernel start does (it already owns the
official row).

### 6. Git credentials on any host

A marketplace credential is a **username plus a token**, sent as HTTP Basic to the marketplace's
origin only (unchanged rule).

- New column `marketplaces.username text NULL`; the admin form gets a "Username" field next to the
  token; the extra manifest has `username`.
- Empty username = `x-access-token` (today's value), so existing GitHub marketplaces are unchanged.
- The form pre-fills a suggestion by host from a small table in the SDK (`github.com` / `*.ghe.com`
  → `x-access-token`, `bitbucket.org` → `x-token-auth`, `gitlab.com` → `oauth2`), the
  `GIT_HOST_USERNAMES` idea used for connectors. The table is a hint for the form only; the kernel
  sends whatever is stored, so any other host (Gitee, Gitea, a self-hosted GitLab) works by entering
  the username its documentation names. That is about credentials only: a bootstrap git entry's
  commit must also be fetchable by its sha from the host ("As built": fetchable commits).
- `GitOptions` gains `username`; `git-source.ts` builds the header from it.
- Http marketplaces keep `Authorization: Bearer <token>`.

### 7. Default theme

**When.** Not at the end of a bootstrap run: in compose the `init` container completes the run and
every kernel start then skips it (`isDone`). Instead, **every kernel start** runs
`applyBootstrapDefaults()` right after the second bootstrap pass point in the lifecycle (after the
extensions loaded, object store available), whether or not a run happened. It is cheap and a no-op
unless the setting is still the seed, so a theme that was not eligible yet (row not created,
plugin failed) is retried at the next start.

**What**, if `defaultTheme` is set, in one `@Transactional()` method:

1. Resolve `(plugin, theme)` to the `platform_themes` UUID (`plugin_name`, `name`, live,
   `owner_org_id IS NULL`); missing → warn and stop.
2. Take the locks **in the order `SettingsService.write` takes them** (`settings.ts:973-985`):
   the super-admin `XactLock` (a new `SuperAdminLock.lock()` call with no actor, the entry the CLI
   and bootstrap already use), `lockThemeShared(id)`, `lockUiThemeRow`.
3. Apply only if the locked value is `{ id: null }` **and** `updated_by IS NULL`: nobody ever saved
   the setting (the 0103 seed). A super admin who chose the built-in theme on purpose wrote
   `updated_by`, so it is respected.
4. `assertPlatformDefaultEligible`; ineligible → warn and stop.
5. Write `{ id }` with `updated_by NULL`; audit `deployment.settings.updated` with actor
   `bootstrap` and detail `{ defaultTheme }`.

This is a system write path in `SettingsService` (`applyBootstrapUiTheme(themeId)`), beside
`update`, sharing its lock order. A restart or a second replica is a no-op once applied, and a
super admin's later choice is never reset. It never fails the start.

### 8. CLI, image, compose

- `capybara bootstrap` reads `bootstrap.extraManifest` from config; `--extra-manifest <file>`
  overrides it (beside the existing `--manifest`, which still replaces the built-in file for tests).
- Image: nothing new; a distribution mounts its file (e.g. `/app/distribution/bootstrap.extra.json`)
  into `init` and the kernel services and sets `CAPYBARA_BOOTSTRAP__EXTRA_MANIFEST`. The compose
  comment on `init` documents it next to the offline-directory example.

### 9. Tooling for distributions (`@capybara-hq/plugin-tools`)

`capybara-plugin bootstrap --check [--file bootstrap.extra.json] [--network]`:

- offline: the file parses; every `git` entry's tree at `commit` (read from the local clone) packs,
  with the kernel's `packPackageTgz`, to `integrity`;
- `--network`: `npm` entries match the registry tarball;
- `--write` sets each `git` entry's `commit` to `HEAD`, its `version` from the plugin's
  `plugin.json` and its `integrity` from the pack, and writes the packs into `--out <dir>` for the
  offline directory.

### 10. Errors

New codes, registered as usual: `bootstrap.extra_invalid` (parse errors, listed),
`bootstrap.extra_conflict` (name in both files), `bootstrap.git_read_failed` (with the git error,
never the token), `marketplace.config_managed`.

## Testing

- SDK: `parseBootstrapExtraManifest` (valid, strict keys, `defaultTheme` on a non-builtin entry,
  duplicate marketplace names, `official` reserved); JSON Schema round trip with ajv.
- Kernel integration (`extensions/bootstrap.test.ts` style, fake npm registry, a local git server
  fixture for `git` entries):
  - fresh deployment: built-in plus extra entries installed; theme becomes the platform default;
  - offline: a `git` entry satisfied from the offline dir without network;
  - restart: no re-run, no theme rewrite; super admin's choice (including an explicit `null`) kept;
  - an extra entry removed from the file → `required_cleared` / builtin cleared like a built-in
    one (`extensions/bootstrap-default-theme.test.ts`);
  - a service started without the extra manifest while managed marketplaces exist changes nothing
    (R14);
  - name conflict fails the step;
  - managed marketplace: created, read-only, token from config, username sent.
- Dual-replica (`container` project, `bootstrap.dual.test.ts`): two kernels start with the extra
  manifest; one run, one theme write.
- `git-source` unit: header built from username; token sent only to the origin.
- CLI: `capybara bootstrap --extra-manifest`.
- plugin-tools: `bootstrap --check` fixtures (good, bad integrity, bad path).

## Specs amended

- Package ecosystem spec §7 (bootstrap): the extra manifest, merge, `git` entries.
- Startup bootstrap spec: amendment "Extra manifest" (merged run identity, git entries in the CLI).
- Package ecosystem spec §5.4: managed marketplaces, the username column.
- Themes spec §7: the bootstrap default (seed-only rule).
- `.agents/skills/writing-plugins/SKILL.md`: "Bootstrap plugins" and the git token line.

## AGENTS.md rules touched

- **Extensions — bootstrap plugins pinned in `packages/kernel/bootstrap.json`:** still true for the
  built-in manifest; the rule gains "a deployment may add pinned entries through
  `bootstrap.extraManifest`, merged, never overriding". `required` / `builtin` keep their meaning.
  The AGENTS.md line is updated in the same change.
- **Plugins and the catalog — downloads always verified against recorded integrity:** every
  entry, npm, offline tgz or git, is verified against its recorded `integrity` before it is read;
  a git entry is also read only at its pinned 40-hex `commit`. No unpinned fetch exists.
- **Plugins and the catalog — admin-supplied URLs through `packages/kernel/src/net`:** manifest
  marketplace URLs are checked and fetched through the same policy as admin-added ones.
- **Multi-replica discipline:** the run stays under the Redis `lock:bootstrap`; the default-theme
  write runs inside it, under the super-admin `XactLock`, in a `@Transactional()` method, and is
  idempotent by its seed-only condition. No in-process state is added.
- **Config:** new fields follow `CAPYBARA_<A>__<B>`; `marketplaces.tokens` is `secret`; neither is
  hot; `docs/config.md` regenerated.
- **Migrations:** one expand-only file adding two nullable columns with `IF NOT EXISTS`.
- **Before 0.1.0:** no compatibility layer; the built-in manifest format is unchanged.

## Decisions taken in this draft (for the reviewer)

1. Tokens for manifest marketplaces come from `marketplaces.tokens` in config, never from the file
   or the secrets table.
2. `defaultTheme` must name a `builtin` entry of the same file.
3. A managed marketplace whose name leaves the file is kept as an ordinary custom marketplace, not
   deleted.
4. The seed-only rule (`updated_by IS NULL`) decides "unset"; an explicit `null` by a person wins.
5. `git` entries are accepted only in the extra manifest; the built-in manifest keeps npm and
   workspace entries.
6. A `git` entry's `integrity` is defined on the kernel's `packPackageTgz` pack, so the online and
   offline paths are verified against one value; `capybara-plugin` reuses that function.
7. The catalog records a `git` entry with the git source detail of the managed marketplace, so admin
   upgrades from it match (see "As built": the import kind stays `bootstrap`).
8. The default theme is applied by every kernel start (seed-only), not by the bootstrap run, so the
   compose `init` path and retries work.

## As built (2026-11-20)

Rulings taken while implementing; where they differ from the text above, they win.

- **R12, source identity:** git entries are imported with kind `bootstrap`, not `marketplace`. The
  install source stays `bootstrap`, so manifest version bumps apply, the package stays in PG and
  keeps the bootstrap pre-approval. Source identity with admin imports from the managed marketplace
  holds through the git source detail; `followsBranch` in it is `true`, the same as an admin import
  of a marketplace `path` entry.
- **R13:** `syncExtraFromConfig` backfills `catalog_items.marketplace_id = 'config:<name>'` for live
  platform items whose latest version came from a bootstrap git entry of that marketplace (the
  compose `init` runs `capybara bootstrap` before any start, when the managed row does not exist
  yet).
- **R5:** a git entry's integrity is the raw tree pack (`packPackageTgz`), verified before any
  Claude-plugin or skills-only translation.
- **R6 / R8:** a git entry's marketplace URL must be in git form: an https URL ending in `.git`
  (the SDK accepts only https URLs); every common host accepts `.git` clone URLs.
- **R9:** the start syncs config-managed marketplaces with one retry on 40P01 / 40001, then warns
  and continues.
- **R10:** the bootstrap default-theme audit row has actor NULL and detail
  `{ source: "bootstrap", uiTheme: { id }, defaultTheme }`.
- **R7:** a row becoming config-managed drops any `catalog-token:<id>` from secrets.
- **Git credentials:** username plus token; an empty username means `x-access-token`; the admin form
  only suggests usernames for known hosts (github.com, `*.ghe.com`, bitbucket.org, gitlab.com); any
  other host (Gitee, Gitea, self-hosted GitLab) works by entering the username its documentation
  names.
- **Fetchable commits:** a git entry is read at its 40-hex `commit` with a depth-1 fetch by sha.
  The commit must be fetchable by its sha from the host: GitHub always allows it; GitLab, Gitea and
  other hosts only when fetching unadvertised commits is allowed (git's
  `uploadpack.allowReachableSHA1InWant` or the host's equivalent). Otherwise pin the commit of a
  tag and keep the tag, or ship the offline packs (`capybara-plugin bootstrap --write --out <dir>`)
  in the offline directory. A refused commit fails `bootstrap.git_read_failed` with exactly this
  hint (never the token).
- **R14, one extra manifest for every service:** a service started without
  `bootstrap.extraManifest` while config-managed marketplaces exist (`managed = 'config'`) is a
  configuration mismatch, decided from the database before the sync and the bootstrap step: it
  demotes nothing, runs neither bootstrap pass and logs an error naming
  `CAPYBARA_BOOTSTRAP__EXTRA_MANIFEST`; the start itself continues. `capybara bootstrap` refuses
  the same case with exit 1. Removing a distribution means pointing `bootstrap.extraManifest` at a
  file whose `marketplaces` and `plugins` lists are empty: its marketplaces are demoted (a warning
  lists them) and its entries lose `required` / `builtin`.
- **R16, the mismatch re-checked under the lock:** the R14 decision runs before `lock:bootstrap`,
  so replicas starting together could race it. `BootstrapService.run` checks again once it holds
  the lock: a manifest without an extra manifest while config-managed marketplaces exist throws
  `BootstrapExtraMismatchError` before anything is obtained or written (the start logs the R14
  error and goes on; `capybara bootstrap` exits 1), and `syncExtraFromConfig(undefined)` (a
  process without an extra manifest) never demotes.
- **Repository root:** a git entry's `path` may be `.` / `./` (a single-plugin repository).
- **Several repositories:** `capybara-plugin bootstrap` reads every git entry from `--root`; a
  manifest whose git entries come from more than one marketplace is checked and pinned once per
  repository with `--marketplace <name>` (the other entries are left as they are).
