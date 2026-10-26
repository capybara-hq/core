import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./source.js";

/**
 * Terminology guard (phase 0a of the package ecosystem spec, §13): the old names of the extension,
 * catalog and plugin domains must not come back. Six rules:
 *
 * - terms-sdk-api: the plugin SDK API report declares none of the old extension-meaning names
 *   nor the M6 / M7 package-format names ({@link SDK_OLD_NAMES});
 * - terms-error-code: `ERROR_CODES` has no `directory.*` or `app.*` key (except the directory
 *   sync codes in {@link ERROR_CODE_ALLOWLIST});
 * - terms-config-key: the kernel config schema has none of the old top-level keys;
 * - terms-route: no kernel route (controller path joined with the method path, or a literal
 *   `/api/v1/...` string) uses an old admin or org path;
 * - terms-cli: the CLI help (`apps/capybara/src/args.ts`) names no extension subcommand under
 *   `capybara plugins` (`list` and `import` are the catalog's);
 * - terms-reference: no tracked file uses a code-shaped old name (SDK and kernel identifiers,
 *   tables, env vars, config keys, routes, CLI commands, check names, skill folders, the M6 / M7
 *   package formats), outside the frozen and intentional places in {@link REFERENCE_EXEMPT_PATHS} /
 *   {@link REFERENCE_EXEMPT_LINES} and a rule's own `allowedIn` paths.
 *   A line already reported by one of the rules above is not reported twice.
 */
export function checkTerms(root: string): Finding[] {
  const specific = [
    ...checkSdkApi(root),
    ...checkErrorCodes(root),
    ...checkConfigKeys(root),
    ...checkRoutes(root),
    ...checkCli(root),
  ];
  const seen = new Set(specific.map((f) => `${f.file}:${f.line}`));
  const references = checkReferences(root).filter((f) => !seen.has(`${f.file}:${f.line}`));
  return [...specific, ...references];
}

export const SDK_API_FILE = "packages/plugin-sdk/api/plugin-sdk.api.md";
export const ERRORS_FILE = "packages/kernel/src/errors.ts";
export const CONFIG_SCHEMA_FILE = "packages/kernel/src/config/schema.ts";
export const KERNEL_SRC_DIR = "packages/kernel/src";
export const CLI_ARGS_FILE = "apps/capybara/src/args.ts";

/**
 * SDK identifiers in the API report that must not appear: the names in which "plugin" meant the
 * extension (since phase 0b "plugin" means the bundle, so new names such as `PluginManifest` are
 * fine). Each pattern is tested against whole identifiers.
 */
export const SDK_OLD_NAMES: readonly RegExp[] = [
  /\bdefinePlugin\b/,
  /\bPluginContext\b/,
  /\bStaticPluginManifest\b/,
  /\bPluginPermissions?\b/,
  /\bPLUGIN_NAME_RE\b/,
  /\bPluginStorage\b/,
  /\bPLUGIN_TOOL_NAME\b/,
  /Capabilit|CAPABILIT/,
  // the M6 / M7 package formats, removed in phase 0b
  /\bPluginPackageSection\b/,
  /\bvalidatePluginPackageJson\b/,
  /\bPLUGIN_PACKAGE_ENTRY\b/,
  /\bAppPluginRef\b/,
  /\bisKnownConnectorPlugin\b/,
];

const IDENTIFIER = /[A-Za-z0-9_$]+/g;

const OLD_ERROR_PREFIX = /^\s*"((?:directory|app)\.[^"]*)"\s*:/;

/** `directory.*` codes of directory sync (`directory@1`), which keeps its name. */
export const ERROR_CODE_ALLOWLIST: ReadonlySet<string> = new Set(["directory.not_configured"]);

export const OLD_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "plugins",
  "pluginConfig",
  "pluginHost",
  "pluginPermissions",
  "catalogs",
  "directory",
]);

/** Old route shapes (path without the leading slash). */
const OLD_ROUTES: { re: RegExp; what: string }[] = [
  { re: /^api\/v1\/admin\/plugins(?:\/|$)/, what: "/api/v1/admin/plugins (now /extensions)" },
  { re: /^api\/v1\/admin\/directory(?:\/|$)/, what: "/api/v1/admin/directory (now /catalog)" },
  { re: /^api\/v1\/admin\/catalogs(?:\/|$)/, what: "/api/v1/admin/catalogs (now /marketplaces)" },
  { re: /\/app-installs(?:\/|$)/, what: "/app-installs (now /plugin-installs)" },
  { re: /orgs\/:orgId\/directory(?:\/|-|$)/, what: "/orgs/:orgId/directory (now /catalog)" },
  { re: /\/directory-requests(?:\/|$)/, what: "/directory-requests (now /catalog-requests)" },
];

/** A path where one {@link OLD_REFERENCES} rule (only that rule) does not apply, with the reason. */
export interface RuleExemption {
  path: RegExp;
  reason: string;
}

/**
 * Code-shaped old names searched in every tracked file. Only spellings that cannot be a new or a
 * frozen name are listed (frozen: `plugin_<name>` schemas, `/plugin-ui`, `directory@1`,
 * `directory_exclusions`, `skills_catalog`, model `capabilities`, `PLUGIN_UNLOADED_TOOL_ERROR`, ...).
 * `allowedIn` lifts one rule for the listed paths; every other rule still applies there.
 */
export const OLD_REFERENCES: { re: RegExp; what: string; allowedIn?: RuleExemption[] }[] = [
  {
    re: /\b(?:definePlugin|StaticPluginManifest|PluginManifestError|PluginContext|PluginPermissionError|PluginStorage|PLUGIN_NAME_RE|PLUGIN_TOOL_NAME|CapabilityRef|CapabilityInfo|CAPABILITIES|CAPABILITY_CARDINALITY|parseCapability|CapabilityUnavailableError|[A-Z_]+_CAPABILITY(?:_V2)?|DIRECTORY_ITEM_NAME_RE)\b|\bctx\.capabilities\b/,
    what: "an old SDK name (now Extension* / extension point names)",
  },
  {
    re: /\b(?:PluginHost|PluginInstalls|PluginAdminOps|PluginApprovals|PluginDeploymentConfigs|DirectoryService|OrgDirectoryService|CatalogsService|AppImport|AppInstaller)\b/,
    what: "an old kernel class name",
  },
  {
    re: /\b(?:plugin_packages|plugin_blobs|plugin_name_owners|plugin_replica_status|plugin_permission_snapshots|plugin_org_configs|plugin_deployment_configs|plugin_directory_sources|catalog_sources|catalog_entries|directory_items|directory_item_versions|directory_requests|directory_org_grants|app_installs|app_install_components|app_import_staging|directory_item_id|directory_version|catalog_source_id)\b/,
    what: "an old table or column name",
  },
  {
    re: /\bCAPYBARA_(?:PLUGINS|PLUGIN_CONFIG|PLUGIN_HOST|PLUGIN_PERMISSIONS|CATALOGS|DIRECTORY)(?:__\w*)?\b/,
    what: "an old config env var (now CAPYBARA_EXTENSION* / CAPYBARA_MARKETPLACES / CAPYBARA_CATALOG)",
  },
  {
    re: /\b(?:pluginConfig|pluginHost|pluginPermissions)\b/,
    what: "an old config key (now extensionConfig / extensionHost / extensionPermissions)",
  },
  {
    re: /\/api\/v1\/admin\/(?:plugins|directory|catalogs)\b|\/app-installs\b|orgs\/:orgId\/directory\b|\/directory-requests\b/,
    what: "an old HTTP route",
  },
  {
    // /admin/plugins and /settings/plugins are not listed: they are the new bundle pages
    re: /(?<![\w/])\/admin\/directory\b|\/settings\/apps\b/,
    what: "an old web page (now /admin/catalog / /settings/plugins)",
  },
  {
    // `capybara plugins list | import` manage the catalog; the extension subcommands stay banned.
    re: /\bcapybara plugins (?:review|approve|enable|disable|uninstall|state)\b/,
    what: "an old CLI command (now capybara extensions ...)",
  },
  {
    re: /\bcheck:plugin-(?:permissions|state)\b|(?<![\w-])perm-capability\b/,
    what: "an old check name (now check:extension-permissions / check:extension-state / perm-extension-point)",
  },
  {
    // `writing-plugins` is a skill folder again since plan 0b: it covers plugins (bundles), spec §6.2.
    re: /\bwriting-apps\b|\bwriting-plugin-ui\b/,
    what: "an old skill folder (now writing-plugins / writing-extension-ui)",
  },
  { re: /\borg\.plugins\.manage\b/, what: "an old RBAC action (now org.extensions.manage)" },
  {
    re: /\b(?:assertPluginSecretsReachable|pluginDeploymentSecretValues)\b/,
    what: "an old @capybara-hq/testing helper (now assertExtensionSecretsReachable / extensionDeploymentSecretValues)",
  },
  {
    // The M6 / M7 package formats (the `capybara` package.json section, `app.yaml` bundles, the
    // catalog `index.json`), removed in phase 0b: no readers, no aliases (spec §4.2).
    re: /(?<![\w-])app\.yaml\b|\bcapybara\.kind\b|\b(?:parseAppManifest|PACKAGE_KINDS|parseCatalogIndex|CatalogIndex(?:Schema)?|appBundleTgz)\b/,
    what: "an old package format name (now .capybara-plugin/plugin.json / marketplace.json)",
    allowedIn: [
      {
        path: /^packages\/kernel\/src\/(?:catalog\/plugin-package|extensions\/sync|packages\/tgz)\.ts$/,
        reason: "the legacy-format detector recognises the old formats to refuse them",
      },
      {
        path: /^packages\/kernel\/test\/(?:catalog\/plugin-import|extensions\/(?:admin-approve\.http|installs|package))\.test\.ts$|^packages\/kernel\/test\/helpers\/plugin-packages\.ts$/,
        reason: "the legacy-format tests build old-format packages and pin the repack message",
      },
      {
        path: /^packages\/kernel\/src\/migrations\/0044_catalog_one_kind\.sql$/,
        reason: "migration 0044 removes the old-format catalog content and says why",
      },
    ],
  },
];

/** Paths (prefix or full path) never searched by terms-reference, with the reason. */
export const REFERENCE_EXEMPT_PATHS: { path: RegExp; reason: string }[] = [
  {
    path: /^packages\/kernel\/src\/migrations\/00(?:[0-3]\d|40)_/,
    reason: "applied migrations 0001-0040 are never edited",
  },
  {
    path: /^packages\/kernel\/src\/migrations\/004[1-3]_/,
    reason: "the phase-0a rename migrations name the old tables to rename them",
  },
  {
    path: /^packages\/kernel\/test\/db\/rename-[\w-]+-migration\.test\.ts$/,
    reason: "the rename migration tests build the pre-rename schema",
  },
  {
    path: /^docs\/superpowers\/plans\/(?:202[0-5]-|2026-0\d-|2026-10-(?:[01]\d|2[0-3])-)/,
    reason: "historical plans (dated before 2026-10-24) are a record",
  },
  {
    path: /^docs\/superpowers\/plans\/2026-10-24-ecosystem-phase0a-terminology\.md$/,
    reason: "the phase-0a plan defines the rename",
  },
  {
    path: /^docs\/superpowers\/plans\/2026-10-25-ecosystem-phase0b-formats\.md$/,
    reason:
      "the phase-0b plan reintroduces plugin names for bundles (PluginManifest, capybara plugins, writing-plugins)",
  },
  {
    path: /^docs\/superpowers\/specs\/2026-10-22-package-ecosystem-design\.md$/,
    reason:
      "the ecosystem spec defines the rename (§13) and reuses old names for plan 0b (writing-plugins for bundles, §6.2)",
  },
  {
    path: /^\.agents\/skills\/(?:onboarding|contributing|reviewing-prs)\//,
    reason: "synced from capybara-hq/.github",
  },
  { path: /^tools\/checks\/fixtures\//, reason: "check fixtures (violations are intentional)" },
  {
    path: /^packages\/plugin-tools\/fixtures\//,
    reason: "plugin check fixtures (violations are intentional)",
  },
  {
    path: /^tools\/checks\/(?:src|test)\/terms(?:\.test)?\.ts$/,
    reason: "this check lists the old names",
  },
];

/** Single lines allowed to keep an old name, with the reason. */
export const REFERENCE_EXEMPT_LINES: { path: string; line: RegExp; reason: string }[] = [
  {
    path: "packages/kernel/test/admin/admin.http.test.ts",
    line: /^\s*[`"]\/api\/v1\/(?:admin\/(?:plugins|directory|catalogs)|orgs\/\$\{org\.id\}\/app-installs)/,
    reason: "the old-routes-are-gone test probes the old routes",
  },
  {
    path: "packages/kernel/test/config/load.test.ts",
    line: /CAPYBARA_PLUGIN_CONFIG__|"pluginConfig" in config/,
    reason: "the test pins that the old env var is ignored",
  },
  {
    path: "docs/deploy/upgrade.md",
    line: /->/,
    reason: "the upgrade notes map each old name to its new one",
  },
];

function read(root: string, rel: string): string | undefined {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
}

function missing(root: string, rel: string, rule: string): Finding {
  return {
    file: join(root, rel),
    line: 1,
    rule,
    message: `${rel} is missing; the terminology guard cannot check it`,
  };
}

function checkSdkApi(root: string): Finding[] {
  const rule = "terms-sdk-api";
  const text = read(root, SDK_API_FILE);
  if (text === undefined) return [missing(root, SDK_API_FILE, rule)];
  const out: Finding[] = [];
  text.split("\n").forEach((l, i) => {
    for (const m of l.matchAll(IDENTIFIER)) {
      if (!SDK_OLD_NAMES.some((re) => re.test(m[0]))) continue;
      out.push({
        file: join(root, SDK_API_FILE),
        line: i + 1,
        rule,
        message: `SDK API declares "${m[0]}"; use the extension / extension point names`,
      });
    }
  });
  return out;
}

/** Lines of the top-level object literal that starts on the line matching `start`. */
function objectBody(text: string, start: RegExp): { text: string; line: number }[] | undefined {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => start.test(l));
  if (at < 0) return undefined;
  const out: { text: string; line: number }[] = [];
  for (let i = at + 1; i < lines.length && !/^\}/.test(lines[i] as string); i++) {
    out.push({ text: lines[i] as string, line: i + 1 });
  }
  return out;
}

function checkErrorCodes(root: string): Finding[] {
  const rule = "terms-error-code";
  const text = read(root, ERRORS_FILE);
  const body = text && objectBody(text, /^export const ERROR_CODES = \{/);
  if (!body) return [missing(root, ERRORS_FILE, rule)];
  return body.flatMap((l) => {
    const m = OLD_ERROR_PREFIX.exec(l.text);
    return m && !ERROR_CODE_ALLOWLIST.has(m[1] as string)
      ? [
          {
            file: join(root, ERRORS_FILE),
            line: l.line,
            rule,
            message: `error code "${m[1]}" uses an old prefix (directory.* is now catalog.*, app.* is now plugin.*)`,
          },
        ]
      : [];
  });
}

function checkConfigKeys(root: string): Finding[] {
  const rule = "terms-config-key";
  const text = read(root, CONFIG_SCHEMA_FILE);
  const body = text && objectBody(text, /^export const KernelConfigSchema = z\.object\(\{/);
  if (!body) return [missing(root, CONFIG_SCHEMA_FILE, rule)];
  return body.flatMap((l) => {
    const m = /^ {2}"?([A-Za-z_$][\w$]*)"?\s*:/.exec(l.text);
    return m && OLD_CONFIG_KEYS.has(m[1] as string)
      ? [
          {
            file: join(root, CONFIG_SCHEMA_FILE),
            line: l.line,
            rule,
            message: `config key "${m[1]}" uses an old name (extensions, extensionConfig, extensionHost, extensionPermissions, marketplaces, catalog)`,
          },
        ]
      : [];
  });
}

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTs(p));
    else if (e.isFile() && /\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const CONTROLLER = /@Controller\(\s*(?:"([^"]*)"|'([^']*)')?\s*\)/;
const METHOD_ROUTE = /@(?:Get|Post|Put|Patch|Delete|All|Head|Options)\(\s*(?:"([^"]*)"|'([^']*)')/;
const API_LITERAL = /["'`](\/api\/v1\/[^"'`]*)["'`]/g;

function checkRoutes(root: string): Finding[] {
  const rule = "terms-route";
  const out: Finding[] = [];
  for (const file of listTs(join(root, KERNEL_SRC_DIR))) {
    let prefix = "";
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((l, i) => {
        const paths: string[] = [];
        const c = CONTROLLER.exec(l);
        if (c) {
          prefix = (c[1] ?? c[2] ?? "").replace(/^\/|\/$/g, "");
          paths.push(prefix);
        }
        const m = METHOD_ROUTE.exec(l);
        if (m) {
          const sub = (m[1] ?? m[2] ?? "").replace(/^\/|\/$/g, "");
          paths.push([prefix, sub].filter((s) => s !== "").join("/"));
        }
        for (const lit of l.matchAll(API_LITERAL)) paths.push((lit[1] as string).slice(1));
        const hit = paths.flatMap((p) => OLD_ROUTES.filter((r) => r.re.test(p)).map((r) => [p, r]));
        const first = hit[0] as [string, { what: string }] | undefined;
        if (first) {
          out.push({
            file,
            line: i + 1,
            rule,
            message: `route "/${first[0]}" uses ${first[1].what}`,
          });
        }
      });
  }
  return out;
}

/**
 * The CLI help may name `capybara plugins` (list, import: the catalog) but not the extension
 * subcommands, which belong to `capybara extensions`.
 */
function checkCli(root: string): Finding[] {
  const rule = "terms-cli";
  const text = read(root, CLI_ARGS_FILE);
  if (text === undefined) return [missing(root, CLI_ARGS_FILE, rule)];
  return text.split("\n").flatMap((l, i) =>
    /\bcapybara plugins (?:review|approve|enable|disable|uninstall|state)\b/.test(l)
      ? [
          {
            file: join(root, CLI_ARGS_FILE),
            line: i + 1,
            rule,
            message:
              "CLI help names an extension subcommand under `capybara plugins`; extensions are managed by `capybara extensions`",
          },
        ]
      : [],
  );
}

/** Tracked and untracked (not ignored) files under root, relative to it. */
function listFiles(root: string): string[] {
  const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git ls-files failed in ${root}: ${r.stderr}`);
  return r.stdout
    .split("\0")
    .filter((f) => f !== "")
    .sort();
}

function checkReferences(root: string): Finding[] {
  const rule = "terms-reference";
  const out: Finding[] = [];
  for (const rel of listFiles(root)) {
    if (REFERENCE_EXEMPT_PATHS.some((e) => e.path.test(rel))) continue;
    const p = join(root, rel);
    // deleted in the working tree, or a symlink (its target is listed itself)
    if (!existsSync(p) || !lstatSync(p).isFile()) continue;
    const buf = readFileSync(p);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    const exemptLines = REFERENCE_EXEMPT_LINES.filter((e) => e.path === rel);
    buf
      .toString("utf8")
      .split("\n")
      .forEach((l, i) => {
        const hit = OLD_REFERENCES.find(
          (r) => r.re.test(l) && !r.allowedIn?.some((e) => e.path.test(rel)),
        );
        if (!hit || exemptLines.some((e) => e.line.test(l))) return;
        out.push({
          file: p,
          line: i + 1,
          rule,
          message: `${hit.what}: "${(l.match(hit.re) as RegExpMatchArray)[0]}"`,
        });
      });
  }
  return out;
}
