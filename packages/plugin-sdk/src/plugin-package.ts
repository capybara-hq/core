import semver from "semver";
import type { z } from "zod";
import { ConnectorAuthSchema } from "./connector-auth.js";
import { EXTENSION_NAME_RE, type ExtensionManifest } from "./define-extension.js";
import { type GitSource, validateGitSource } from "./git-hosts.js";
import type { ExtensionPermissions } from "./permissions.js";
import type { PluginManifest } from "./plugin-manifest.js";

/**
 * Plugin package (npm-pack tgz) rules shared by the SDK, the packer and the kernel (spec §4.1). Pure
 * functions only: the kernel reads the tgz and scans imports, `packages/plugin-tools` packs it. The
 * manifest is `.capybara-plugin/plugin.json` (plugin-manifest.ts); an extension's static manifest
 * ({@link StaticExtensionManifest}) is written into it by the packer and compared with the real
 * module's {@link staticManifestOf} at load (a difference is `manifest_mismatch`). The extension
 * entry is single-file ESM with third-party dependencies bundled; only {@link HOST_PROVIDED_PACKAGES}
 * come from the host.
 */

/** Packages provided by the host (peerDependencies, linked to the host's copy on install); every other third-party dependency must be bundled into the entry. */
export const HOST_PROVIDED_PACKAGES = ["@capybara-hq/plugin-sdk", "zod"] as const;

/** Scripts npm runs automatically on install: a plugin package must never have any (installs run no scripts, so having them would mislead). */
export const FORBIDDEN_INSTALL_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
] as const;

/** Dependency fields that must not appear: third-party dependencies must be bundled into the entry. */
const FORBIDDEN_DEP_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "bundleDependencies",
  "bundledDependencies",
] as const;

/** A config field in the static manifest (a dotted path; an empty string when the root is itself the leaf). */
export interface StaticConfigField {
  path: string;
  secret: boolean;
  hot: boolean;
}

/** The static part of the plugin manifest (JSON-serializable; excludes setup, zod schemas and migration paths). */
export interface StaticExtensionManifest {
  name: string;
  version: string;
  sdk: string;
  provides: string[];
  requires: string[];
  optional: string[];
  permissions: ExtensionPermissions;
  ui?: ExtensionManifest["ui"];
  config: { deployment: StaticConfigField[]; org: StaticConfigField[] };
}

/** An import in the entry module: `name` is the specifier (an empty string for a dynamic import that is not a literal). */
export interface EntryImport {
  name: string;
  dynamic: boolean;
  literal: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** npm package name rule (simplified): may carry a scope, lowercase, ≤ 214 characters (the length is checked separately). */
export const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const NPM_NAME_RE = NPM_PACKAGE_NAME_RE;

/**
 * Whether a path relative to the package is safe: non-empty, not starting with `/`, no `\`, control characters or drive letters, no empty segments, `.` or `..` segments, ≤ 1024 characters.
 */
export function isSafePackagePath(p: string): boolean {
  if (typeof p !== "string" || p === "" || p.length > 1024) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what must be rejected
  if (p.startsWith("/") || p.includes("\\") || /[\u0000-\u001f\u007f]/.test(p)) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

const isHostPackage = (name: string) =>
  HOST_PROVIDED_PACKAGES.some((h) => name === h || name.startsWith(`${h}/`));

/**
 * Checks the entry module's imports (C11): static and literal dynamic imports may only be `node:*`, {@link HOST_PROVIDED_PACKAGES} (subpaths included)
 * and in-package relative paths (`./`, `../`; whether they escape the package is judged by the caller from the file location); non-literal dynamic imports are always rejected.
 * Returns the list of problems (empty means valid).
 */
export function checkEntryImports(specifiers: EntryImport[]): string[] {
  const out: string[] = [];
  for (const s of specifiers) {
    if (s.dynamic && !s.literal) {
      out.push("dynamic import() with a non-literal specifier is not allowed");
      continue;
    }
    const n = s.name;
    if (n.startsWith("node:") && n.length > 5) continue;
    if (isHostPackage(n)) continue;
    if (n.startsWith("./") || n.startsWith("../")) continue;
    out.push(
      `import of "${n}" is not allowed: bundle third-party dependencies into the entry ` +
        `(only node:*, ${HOST_PROVIDED_PACKAGES.join(", ")} and relative paths are resolved at load)`,
    );
  }
  return out;
}

const WRAPPERS = new Set(["default", "prefault", "optional", "nullable", "readonly", "catch"]);

interface FieldMeta {
  secret?: unknown;
  hot?: unknown;
}

type AnySchema = z.ZodTypeAny;
const defOf = (s: AnySchema) =>
  s._zod.def as unknown as {
    type: string;
    innerType?: AnySchema;
    shape?: Record<string, AnySchema>;
  };
const metaOf = (s: AnySchema) => s.meta() as FieldMeta | undefined;

/** The same traversal as the kernel's `configFields`: objects are expanded recursively, wrappers such as default / optional are stripped, and a secret on an object is inherited downward. */
function configFieldsOf(
  schema: AnySchema | undefined,
  prefix = "",
  inheritedSecret = false,
): StaticConfigField[] {
  if (!schema) return [];
  let node = schema;
  let meta = metaOf(node);
  while (WRAPPERS.has(defOf(node).type) && defOf(node).innerType) {
    node = defOf(node).innerType as AnySchema;
    meta ??= metaOf(node);
  }
  const secret = inheritedSecret || meta?.secret === true;
  const def = defOf(node);
  if (def.type === "object" && def.shape) {
    return Object.entries(def.shape).flatMap(([k, v]) =>
      configFieldsOf(v, prefix ? `${prefix}.${k}` : k, secret),
    );
  }
  return [{ path: prefix, secret, hot: meta?.hot === true }];
}

const byPath = (a: StaticConfigField, b: StaticConfigField) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const jsonClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * The static part of the real manifest: written into `capybara.manifest` when packing, and compared with the in-package one at load time (`manifest_mismatch`).
 * The result survives a JSON round trip (undefined fields removed); config fields are sorted by path.
 */
export function staticManifestOf(m: ExtensionManifest): StaticExtensionManifest {
  const out: StaticExtensionManifest = {
    name: m.name,
    version: m.version,
    sdk: m.sdk,
    provides: [...m.provides],
    requires: [...(m.requires ?? [])],
    optional: [...(m.optional ?? [])],
    permissions: jsonClone(m.permissions ?? {}),
    config: {
      deployment: configFieldsOf(m.config?.deployment).sort(byPath),
      org: configFieldsOf(m.config?.org).sort(byPath),
    },
  };
  if (m.ui !== undefined) out.ui = jsonClone(m.ui);
  return out;
}

/**
 * The package.json rules shared by every plugin tgz: npm name, semver version, no install scripts,
 * no `gypfile`, no dependency fields, `peerDependencies` only host packages, and a `zod` peer range
 * that is valid (and satisfied by `hostZodVersion` when given). Returns the peerDependencies object.
 */
function checkPluginPackageBasics(
  pkg: Record<string, unknown>,
  opts: { hostZodVersion?: string },
  errs: string[],
): Record<string, unknown> {
  if (typeof pkg.name !== "string" || pkg.name.length > 214 || !NPM_NAME_RE.test(pkg.name)) {
    errs.push("package.json name must be a valid npm package name");
  }
  if (typeof pkg.version !== "string" || semver.valid(pkg.version) === null) {
    errs.push("package.json version must be a valid semver version");
  }
  if (pkg.scripts !== undefined) {
    if (!isObj(pkg.scripts)) errs.push("package.json scripts must be an object");
    else {
      for (const s of FORBIDDEN_INSTALL_SCRIPTS) {
        if (Object.hasOwn(pkg.scripts, s)) {
          errs.push(`package.json scripts.${s} is not allowed: plugin packages never run scripts`);
        }
      }
    }
  }
  if (pkg.gypfile !== undefined && pkg.gypfile !== false) {
    errs.push("package.json gypfile is not allowed: native addons are not supported");
  }
  for (const f of FORBIDDEN_DEP_FIELDS) {
    const v = pkg[f];
    if (v === undefined) continue;
    const empty = Array.isArray(v) ? v.length === 0 : isObj(v) && Object.keys(v).length === 0;
    if (!empty) {
      errs.push(`package.json ${f} is not allowed: bundle third-party dependencies into the entry`);
    }
  }
  let peers: Record<string, unknown> = {};
  if (pkg.peerDependencies !== undefined) {
    if (!isObj(pkg.peerDependencies)) errs.push("package.json peerDependencies must be an object");
    else {
      peers = pkg.peerDependencies;
      for (const k of Object.keys(peers)) {
        if (!(HOST_PROVIDED_PACKAGES as readonly string[]).includes(k)) {
          errs.push(
            `package.json peerDependencies "${k}" is not provided by the host (only ${HOST_PROVIDED_PACKAGES.join(", ")})`,
          );
        }
      }
    }
  }
  const zodRange = peers.zod;
  if (zodRange !== undefined) {
    if (typeof zodRange !== "string" || semver.validRange(zodRange) === null) {
      errs.push("package.json peerDependencies zod must be a valid semver range");
    } else if (
      opts.hostZodVersion !== undefined &&
      !semver.satisfies(opts.hostZodVersion, zodRange, { includePrerelease: true })
    ) {
      errs.push(
        `package.json peerDependencies zod "${zodRange}" is not satisfied by the host zod ${opts.hostZodVersion}`,
      );
    }
  }
  return peers;
}

/**
 * Validates the `package.json` of a plugin tgz against its parsed `.capybara-plugin/plugin.json`
 * ({@link PluginManifest}), returning the problems (empty when valid): the rules shared with every
 * plugin package (npm name, semver version, no install scripts, no `gypfile`, no dependency fields,
 * `peerDependencies` only host packages, a valid `zod` peer range satisfied by `hostZodVersion`),
 * no `capybara` section, the version equal to the manifest's, and:
 * - with an extension: `peerDependencies["@capybara-hq/plugin-sdk"]` present and equal to
 *   `extension.manifest.sdk`, which the host SDK version satisfies (includePrerelease), and
 *   `main` / `exports` absent or naming `extension.entry` (the packer writes both);
 * - without one: no `peerDependencies`, `main` or `exports` at all.
 */
export function validatePluginPackageJsonFor(
  pkg: unknown,
  manifest: PluginManifest,
  hostSdkVersion: string,
  opts: { hostZodVersion?: string } = {},
): string[] {
  if (!isObj(pkg)) return ["package.json must be a JSON object"];
  const errs: string[] = [];
  const peers = checkPluginPackageBasics(pkg, opts, errs);
  if (pkg.capybara !== undefined) {
    errs.push(
      "package.json must not have a capybara section (the manifest is .capybara-plugin/plugin.json)",
    );
  }
  if (typeof pkg.version === "string" && pkg.version !== manifest.version) {
    errs.push(
      `package.json version "${pkg.version}" does not match plugin.json version "${manifest.version}"`,
    );
  }
  const ext = manifest.extension;
  if (ext === undefined) {
    if (isObj(pkg.peerDependencies) && Object.keys(pkg.peerDependencies).length > 0) {
      errs.push(
        "package.json peerDependencies is not allowed in a plugin without an extension (nothing is loaded from the host)",
      );
    }
    for (const f of ["main", "exports"] as const) {
      if (pkg[f] !== undefined) {
        errs.push(
          `package.json ${f} is not allowed in a plugin without an extension (there is no module to load)`,
        );
      }
    }
    return errs;
  }
  errs.push(...entryFieldIssues(pkg, ext.entry));
  const sdk = ext.manifest.sdk;
  const peerSdk = peers["@capybara-hq/plugin-sdk"];
  if (peerSdk === undefined) {
    errs.push(
      `package.json peerDependencies "@capybara-hq/plugin-sdk" is required and must equal extension.manifest.sdk "${sdk}"`,
    );
  } else if (peerSdk !== sdk) {
    errs.push(
      `package.json peerDependencies "@capybara-hq/plugin-sdk" "${String(peerSdk)}" must equal extension.manifest.sdk "${sdk}"`,
    );
  }
  const sdkProblem = hostSdkProblem(sdk, hostSdkVersion);
  if (sdkProblem !== undefined) errs.push(sdkProblem);
  return errs;
}

/**
 * `main` and `exports` of an extension-bearing plugin: absent, or naming the extension entry
 * (`"main": "<entry>"`, `"exports": "<entry>"` or `{ ".": "<entry>" }`), so the package resolves by
 * name (`require.resolve`, a test loading the extension by package name) to the module the kernel
 * loads, and to nothing else.
 */
function entryFieldIssues(pkg: Record<string, unknown>, entry: string): string[] {
  const errs: string[] = [];
  const why = `must be absent or name the extension entry "${entry}"`;
  // `main` may omit the leading ./ (`dist/index.mjs`); an `exports` target must keep it (Node)
  const bare = (p: unknown) => (typeof p === "string" ? p.replace(/^\.\//, "") : p);
  if (pkg.main !== undefined && bare(pkg.main) !== bare(entry)) {
    errs.push(`package.json main ${why}`);
  }
  const ex = pkg.exports;
  const exportsOk =
    ex === undefined ||
    ex === entry ||
    (isObj(ex) && Object.keys(ex).length === 1 && ex["."] === entry);
  if (!exportsOk) errs.push(`package.json exports ${why} (as a string or { ".": "${entry}" })`);
  return errs;
}

/**
 * Whether the host SDK satisfies an extension's `extension.manifest.sdk` range: the problem
 * (English), or undefined when it does (an invalid range is reported by the manifest parser).
 */
export function hostSdkProblem(sdk: string, hostSdkVersion: string): string | undefined {
  if (semver.validRange(sdk) === null) return undefined;
  if (semver.satisfies(hostSdkVersion, sdk, { includePrerelease: true })) return undefined;
  return `extension.manifest.sdk "${sdk}" is not satisfied by the host SDK version ${hostSdkVersion}`;
}

/**
 * Connector template (C30): connector plugin reference + `Connector.kind` + endpoint preset + endpoint paths an org may change + auth preset (no credentials) +
 * default ownership + default policy per tool + icon. When installing, an org may only fill in credentials, the client id / secret and the fields in `editableEndpoint`.
 */
export interface ConnectorTemplateSpec {
  /** Connector plugin name (e.g. `connector-mcp`). */
  plugin: string;
  /** Semver range of the connector plugin, optional. */
  pluginVersion?: string;
  /** `Connector.kind` (e.g. `"mcp"`). */
  connector: string;
  /** Endpoint preset; on import the kernel validates it against that connector's `endpointSchema`. */
  endpoint: Record<string, unknown>;
  /** Dotted paths an org may change when installing (e.g. `"url"`); everything else follows the template. The paths must exist in the connector's endpoint schema. */
  editableEndpoint?: string[];
  /** The same shape as the auth method of the connector install API ({@link ConnectorAuthSchema}), carrying no credentials. */
  auth: Record<string, unknown>;
  /** Defaults to `auth.ownership`; if given it must agree. */
  ownership?: "org" | "personal";
  /** Tool name -> default policy (recorded as `policy_source 'template'` after install). */
  defaultToolPolicies?: Record<string, "allow" | "ask" | "deny">;
  /** Git hosts this connector's credential serves in sandboxes ({@link GitSource}). */
  git?: GitSource;
  /** In-package path, svg / png, ≤ {@link CONNECTOR_TEMPLATE_LIMITS}`.iconBytes`. */
  icon?: string;
}

/** Bilingual display name. */
export interface LocalizedName {
  zh: string;
  en: string;
}

/** Limits of connector templates and catalog segments. */
export const CONNECTOR_TEMPLATE_LIMITS = {
  /** Upper bound on icon bytes. */
  iconBytes: 64 * 1024,
  /** Upper bound on the characters of the endpoint preset after JSON serialization. */
  endpointChars: 16 * 1024,
  /** Upper bound on the number of `editableEndpoint` entries. */
  editablePaths: 50,
  /** Upper bound on the number of `defaultToolPolicies` entries. */
  toolPolicies: 1000,
  /** Upper bound on the characters of publisher. */
  publisherChars: 100,
  /** Upper bound on the characters of description. */
  descriptionChars: 1024,
  /** Upper bound on the characters of displayName per language. */
  displayNameChars: 100,
} as const;

/** Catalog entry name (the same rule as manifest entry names): starts with a lowercase letter or digit, then lowercase letters, digits and hyphens, ≤ 64. */
export const CATALOG_ITEM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** An exact semver version (a regex JSON Schema can use). */
export const SEMVER_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** The sha512 SRI of an npm package tgz: `sha512-<86 base64 chars>==`. */
export const SHA512_INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;

const PATH_SEG_RE = /^[A-Za-z0-9_-]{1,100}$/;
const PROTO_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Credential-style field names (compared lowercased with `-` and `_` removed): templates are seen by every org, so endpoint presets containing these keys are always rejected.
 * Header names such as `authorization` / `cookie` are listed too (credentials in endpoint headers).
 */
const CREDENTIAL_KEYS = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearertoken",
  "authtoken",
  "apikey",
  "apitoken",
  "xapikey",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "privatekey",
  "authorization",
  "proxyauthorization",
  "cookie",
  "sessiontoken",
]);

const normKey = (k: string) => k.toLowerCase().replace(/[-_]/g, "");

/** Recursively finds credential-style keys (reports only paths, never echoes values). */
function credentialKeyPaths(v: unknown, at: string, out: string[], depth = 0): void {
  if (depth > 20) return;
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      credentialKeyPaths(x, `${at}.${i}`, out, depth + 1);
    });
    return;
  }
  if (!isObj(v)) return;
  for (const [k, x] of Object.entries(v)) {
    const p = `${at}.${k}`;
    if (CREDENTIAL_KEYS.has(normKey(k))) out.push(p);
    credentialKeyPaths(x, p, out, depth + 1);
  }
}

const TEMPLATE_KEYS = new Set([
  "plugin",
  "pluginVersion",
  "connector",
  "endpoint",
  "editableEndpoint",
  "auth",
  "ownership",
  "defaultToolPolicies",
  "git",
  "icon",
]);

/**
 * Validates the static part of a connector template ({@link ConnectorTemplateSpec}) and returns the list of problems (empty means valid; paths are relative to the template root, values are not echoed):
 * fields complete, no unknown fields; `auth` conforms to {@link ConnectorAuthSchema} (strict: extra fields such as `token` are rejected);
 * no credential-style key at any level of the endpoint preset; `editableEndpoint` is a list of distinct dotted paths; `ownership` agrees with `auth.ownership`;
 * default policies may only be allow / ask / deny; icon is an in-package .svg / .png path.
 * Whether the endpoint conforms to the connector's `endpointSchema` and whether `editableEndpoint` exists in it is checked by the kernel on import against the loaded connector.
 */
export function validateConnectorTemplate(t: unknown): string[] {
  if (!isObj(t)) return ["template must be an object"];
  const errs: string[] = [];
  for (const k of Object.keys(t)) {
    if (!TEMPLATE_KEYS.has(k)) errs.push(`template has unknown field "${k}"`);
  }
  if (typeof t.plugin !== "string" || !EXTENSION_NAME_RE.test(t.plugin)) {
    errs.push(`template.plugin must be a plugin name matching ${EXTENSION_NAME_RE}`);
  }
  if (
    t.pluginVersion !== undefined &&
    (typeof t.pluginVersion !== "string" || semver.validRange(t.pluginVersion) === null)
  ) {
    errs.push("template.pluginVersion must be a valid semver range");
  }
  if (typeof t.connector !== "string" || t.connector.length < 1 || t.connector.length > 100) {
    errs.push("template.connector must be a connector kind (1-100 characters)");
  }
  if (!isObj(t.endpoint)) errs.push("template.endpoint must be an object");
  else {
    if (JSON.stringify(t.endpoint).length > CONNECTOR_TEMPLATE_LIMITS.endpointChars) {
      errs.push(
        `template.endpoint is larger than ${CONNECTOR_TEMPLATE_LIMITS.endpointChars} characters`,
      );
    }
    const leaks: string[] = [];
    credentialKeyPaths(t.endpoint, "template.endpoint", leaks);
    for (const p of leaks) {
      errs.push(
        `${p} looks like a credential: templates must not contain credentials; organizations provide them when installing`,
      );
    }
  }
  if (t.editableEndpoint !== undefined) {
    if (
      !Array.isArray(t.editableEndpoint) ||
      t.editableEndpoint.length > CONNECTOR_TEMPLATE_LIMITS.editablePaths
    ) {
      errs.push(
        `template.editableEndpoint must be an array of at most ${CONNECTOR_TEMPLATE_LIMITS.editablePaths} paths`,
      );
    } else {
      const seen = new Set<string>();
      for (const p of t.editableEndpoint) {
        const ok =
          typeof p === "string" &&
          p.split(".").every((s) => PATH_SEG_RE.test(s) && !PROTO_KEYS.has(s));
        if (!ok) {
          errs.push(
            `template.editableEndpoint entries must be dot paths of letters, digits, "_" and "-" (got ${JSON.stringify(typeof p === "string" ? p.slice(0, 100) : typeof p)})`,
          );
          continue;
        }
        if (p.split(".").some((seg) => CREDENTIAL_KEYS.has(normKey(seg)))) {
          errs.push(
            `template.editableEndpoint "${p}" looks like a credential field: organizations provide credentials through the connector's auth, not the endpoint`,
          );
          continue;
        }
        if (seen.has(p)) errs.push(`template.editableEndpoint has duplicate path "${p}"`);
        seen.add(p);
      }
    }
  }
  const auth = ConnectorAuthSchema.safeParse(t.auth);
  if (!auth.success) {
    for (const i of auth.error.issues) {
      const path = ["template.auth", ...i.path.map(String)].join(".");
      const keys = (i as { keys?: string[] }).keys;
      errs.push(
        keys && keys.length > 0
          ? `${path} has unknown field(s) ${keys.map((k) => `"${k}"`).join(", ")}: auth presets must not contain credentials`
          : `${path}: ${i.message}`,
      );
    }
  }
  if (t.ownership !== undefined) {
    if (t.ownership !== "org" && t.ownership !== "personal") {
      errs.push('template.ownership must be "org" or "personal"');
    } else if (auth.success) {
      const a = auth.data as { type: string; ownership?: string };
      if (a.type === "none") {
        errs.push("template.ownership is not allowed with auth type none (no credential)");
      } else if (a.ownership !== t.ownership) {
        errs.push(
          `template.ownership "${t.ownership}" does not match template.auth.ownership "${a.ownership}"`,
        );
      }
    }
  }
  if (t.defaultToolPolicies !== undefined) {
    const p = t.defaultToolPolicies;
    if (!isObj(p) || Object.keys(p).length > CONNECTOR_TEMPLATE_LIMITS.toolPolicies) {
      errs.push(
        `template.defaultToolPolicies must be an object with at most ${CONNECTOR_TEMPLATE_LIMITS.toolPolicies} entries`,
      );
    } else {
      for (const [name, v] of Object.entries(p)) {
        if (name.length < 1 || name.length > 200) {
          errs.push("template.defaultToolPolicies keys must be tool names (1-200 characters)");
        } else if (PROTO_KEYS.has(name)) {
          errs.push(`template.defaultToolPolicies key "${name}" is not allowed`);
        } else if (v !== "allow" && v !== "ask" && v !== "deny") {
          errs.push(`template.defaultToolPolicies.${name} must be "allow", "ask" or "deny"`);
        }
      }
    }
  }
  if (t.git !== undefined) errs.push(...validateGitSource(t.git, "template.git"));
  if (t.icon !== undefined) {
    if (typeof t.icon !== "string" || !isSafePackagePath(t.icon) || !/\.(svg|png)$/i.test(t.icon)) {
      errs.push("template.icon must be a relative .svg or .png path inside the package");
    }
  }
  return errs;
}
