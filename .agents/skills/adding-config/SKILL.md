---
name: adding-config
description: 'Use when adding or changing a kernel config option (KernelConfigSchema in packages/kernel/src/config/schema.ts): field meta (hot / secret / description), the rules for deriving environment variable names, and regenerating docs/config.md.'
---

# Adding a kernel config option

Kernel config has a single source of definition: `KernelConfigSchema` (Zod 4) in `packages/kernel/src/config/schema.ts`. An extension's deployment-level config is not added here; it goes in the extension manifest's `config.deployment` (see `.agents/skills/writing-extensions`).

## Steps

1. Add the field to `KernelConfigSchema`, **and give every field a `meta`**:

   ```ts
   // use the meta() from the same file in schema.ts
   timeoutMs: z
     .number()
     .int()
     .positive()
     .default(5000)
     .meta(meta({ description: "Upstream request timeout in milliseconds" })),
   ```

   `meta` fields:
   - `description` (required): one English sentence; it goes into the generated docs.
   - `secret: true`: a sensitive value (connection string, key, token). The docs do not show its default, and logs and error messages must not echo its value.
   - `hot: true`: allows hot reload. Only set it on fields that can safely take effect at runtime (such as `log.level`); by default a field is not hot, and changing it needs a restart.

2. Give sensible fields `.default(...)`; required fields get no default. Nested objects follow the existing style (`z.object({...}).prefault({} as never)` or `.default({...})`).
3. Regenerate the config docs and commit them:

   ```bash
   pnpm gen:config-docs      # writes docs/config.md
   ```

   `pnpm check:config-docs` (part of `pnpm check`) reports `config-docs-stale` when `docs/config.md` disagrees with the schema; do not edit that file by hand.
4. Changes that affect a release get a changeset (`pnpm changeset`; for the kernel usually minor).

## How environment variable names are derived

The rules (consistent with `packages/kernel/src/config/env.ts`):

- Prefix `CAPYBARA_`;
- levels of nesting are joined with a **double underscore** `__`;
- each segment is converted from camelCase to SNAKE_CASE (upper case): `poolMax` -> `POOL_MAX`.

| Config path | Environment variable |
|---|---|
| `db.url` | `CAPYBARA_DB__URL` |
| `db.poolMax` | `CAPYBARA_DB__POOL_MAX` |
| `http.port` | `CAPYBARA_HTTP__PORT` |
| `masterKey` | `CAPYBARA_MASTER_KEY` |
| `extensionConfig` | `CAPYBARA_EXTENSION_CONFIG` |
| new `upstream.timeoutMs` | `CAPYBARA_UPSTREAM__TIMEOUT_MS` |

Values are parsed as JSON (numbers, booleans, arrays and objects can all be passed, e.g. `CAPYBARA_EXTENSIONS='["a","b"]'`); a value that cannot be parsed is taken as a string. Environment variables take precedence **over** the config file / Nacos. Setting both `CAPYBARA_X` (scalar) and `CAPYBARA_X__Y` (nested) is a conflict: startup throws `ConfigError` naming both variables; an empty-string `CAPYBARA_CONFIG_SOURCE` is treated as unset.

**A whole-section JSON value and per-field variables cannot be mixed**: even if `CAPYBARA_X` carries a JSON object (e.g. `CAPYBARA_DB='{"url":"postgres://..."}'`), setting `CAPYBARA_X__Y` as well (e.g. `CAPYBARA_DB__POOL_MAX=5`) is likewise judged a conflict and startup fails; the two are not merged. Pick one style per section of config. Conflicts only consider parent/child paths: `CAPYBARA_DB__URL` and `CAPYBARA_DB__URL_EXTRA`, or `CAPYBARA_LOG` and `CAPYBARA_LOGGING__X`, do not conflict; ignored `CAPYBARA_CONFIG_*` / `CAPYBARA_NACOS_*` variables are removed first and take no part in conflict detection.

`CAPYBARA_CONFIG_*` and `CAPYBARA_NACOS_*` are the choices of the config source itself (`CAPYBARA_CONFIG_SOURCE=file|nacos`, `CAPYBARA_CONFIG_FILE`, `CAPYBARA_NACOS_SERVER` / `_NAMESPACE` / `_DATA_ID`, and the Nacos auth variables `_USERNAME` / `_PASSWORD` / `_ACCESS_TOKEN`) and are **not** treated as config options; do not give a new field a top-level name like `config` or `nacos` that would collide with those prefixes.

When Nacos auth is enabled, choose one of two: `CAPYBARA_NACOS_USERNAME` + `CAPYBARA_NACOS_PASSWORD` (at startup `POST /nacos/v1/auth/login` exchanges them for an accessToken, which is logged in again after 80% of `tokenTtl` has elapsed or when a request receives 403), or `CAPYBARA_NACOS_ACCESS_TOKEN` (used directly, no login). The token is sent as the `accessToken` query parameter on read and listen requests. A failed login fails startup, and the error message contains the server but not the password; setting both methods, or a username and password that are not paired, makes startup report `ConfigError`.

## Master key rotation

The kernel builds a keyring with `createKeyring(masterKey, masterKeyPrevious)`: new wrapping always uses `masterKey`, and `masterKeyPrevious` is only used to unwrap old data keys. `rewrapDataKeys(db, keyring)` (exported from `@capybara-hq/kernel`; M0 has no CLI subcommand yet) re-wraps the org data keys still wrapped by an old master key with the current master key, and returns the number processed. The order must not be changed:

1. Roll out so that **all replicas** have the new keyring: `masterKey` = the new key, `masterKeyPrevious` = `[old key]`.
2. Only after confirming no replica still holds just the old key, run `rewrapDataKeys` (otherwise an old replica cannot open data keys that were re-wrapped with the new key).
3. After the rewrap completes, roll out once more to remove the old key from `masterKeyPrevious`.
