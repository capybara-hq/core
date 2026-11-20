import { z } from "zod";
import { GIT_USERNAME_RE } from "./git-hosts.js";
import {
  CATALOG_ITEM_NAME_RE,
  isSafePackagePath,
  NPM_PACKAGE_NAME_RE,
  SEMVER_VERSION_RE,
  SHA512_INTEGRITY_RE,
} from "./plugin-package.js";

/**
 * The bootstrap manifest `packages/kernel/bootstrap.json` (package ecosystem spec §7): the plugins
 * a deployment installs at init, each pinned to an exact version and the sha512 of its tgz. The
 * bootstrap step verifies every tgz against `integrity` before reading it.
 *
 * Two entry kinds: `source: "npm"` (the published package; the official `marketplace` commit is then
 * required, and `check:bootstrap` compares the entries with it) and `source: "workspace"` (until
 * the official plugins are published: `path` is packed with `packages/plugin-tools`, which is
 * byte-reproducible, and `integrity` is that pack's sha512).
 *
 * `required` and `builtin` are two different promises. A required entry is imported in the first
 * pass, before the extensions load, and the start fails without it (so it can ship no skills or
 * templates: those need object storage, which is not running then). A `builtin` entry is imported
 * once the extensions have loaded (object storage available), so it may ship skills; its failure
 * is logged and retried on the next start. Both give the plugin a builtin catalog item (scope
 * `all`, on in every org, not switchable) and are imported again when missing. An entry is never
 * both.
 *
 * Objects are strict (unknown keys rejected, `$schema` allowed): the manifest ships with core, so
 * there is no older reader to stay compatible with and a misspelt key is a mistake. The committed
 * JSON Schema (`schemas/bootstrap.v1.schema.json`) is generated from {@link BootstrapManifestSchema}
 * by `pnpm gen:package-schemas`; the cross-field rules (unique names, `marketplace` required with an
 * npm entry, not both `required` and `builtin`) are decided only by {@link parseBootstrapManifest}.
 */

/** Manifest format version. */
export const BOOTSTRAP_MANIFEST_SCHEMA_VERSION = 1;

/** One pinned plugin. */
export type BootstrapEntry =
  | {
      /** Catalog item name (`^[a-z0-9][a-z0-9-]{0,63}$`). */
      name: string;
      source: "npm";
      /** npm package name. */
      npm: string;
      /** Exact semver. */
      version: string;
      /** `sha512-<base64>` of the package tgz. */
      integrity: string;
      /** Enabled in every org and neither disableable nor uninstallable. */
      required: boolean;
      /**
       * Builtin but not required: imported after the extensions loaded (it may ship skills), its
       * catalog item builtin; a failure does not stop the start. Never together with `required`.
       */
      builtin?: boolean;
    }
  | {
      name: string;
      source: "workspace";
      /** `plugins/<dir>`, relative to the repository root. */
      path: string;
      version: string;
      integrity: string;
      required: boolean;
      builtin?: boolean;
    };

/** `bootstrap.json`. */
export interface BootstrapManifest {
  $schema?: string;
  schemaVersion: 1;
  /** The official marketplace commit the npm entries are checked against; required with npm entries. */
  marketplace?: { url: string; commit: string };
  /** Names are unique. */
  plugins: BootstrapEntry[];
}

const MAX_ERRORS = 50;
const URL_CHARS = 2000;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const HTTPS_URL_RE = /^https:\/\/\S+$/;
const WORKSPACE_PATH_RE = /^plugins\/[a-z0-9][a-z0-9-]{0,63}$/;

const common = {
  name: z
    .string()
    .regex(CATALOG_ITEM_NAME_RE, { message: "name must match ^[a-z0-9][a-z0-9-]{0,63}$" }),
  version: z
    .string()
    .max(256)
    .regex(SEMVER_VERSION_RE, { message: "version must be an exact semver version" }),
  integrity: z
    .string()
    .regex(SHA512_INTEGRITY_RE, { message: "integrity must be sha512-<86 base64 chars>==" }),
  required: z.boolean(),
  builtin: z.boolean().optional(),
};

const entry = z.discriminatedUnion("source", [
  z.strictObject({
    ...common,
    source: z.literal("npm"),
    npm: z
      .string()
      .max(214)
      .regex(NPM_PACKAGE_NAME_RE, { message: "npm must be an npm package name" }),
  }),
  z.strictObject({
    ...common,
    source: z.literal("workspace"),
    path: z.string().regex(WORKSPACE_PATH_RE, { message: "path must be plugins/<dir>" }),
  }),
]);

const schema = z
  .strictObject({
    $schema: z.string().max(URL_CHARS).optional(),
    schemaVersion: z.literal(BOOTSTRAP_MANIFEST_SCHEMA_VERSION),
    marketplace: z
      .strictObject({
        url: z.string().max(URL_CHARS).regex(HTTPS_URL_RE, { message: "url must be an https URL" }),
        commit: z.string().regex(COMMIT_RE, { message: "commit must be 40 hex characters" }),
      })
      .optional(),
    plugins: z.array(entry).max(500),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.plugins.forEach((e, i) => {
      if (seen.has(e.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["plugins", i, "name"],
          message: `duplicate entry ${e.name}`,
        });
      }
      seen.add(e.name);
      if (e.required && e.builtin === true) {
        ctx.addIssue({
          code: "custom",
          path: ["plugins", i, "builtin"],
          message: "an entry is either required or builtin, not both",
        });
      }
    });
    if (m.marketplace === undefined && m.plugins.some((e) => e.source === "npm")) {
      ctx.addIssue({
        code: "custom",
        path: ["marketplace"],
        message: 'required when an entry has source "npm"',
      });
    }
  });

/**
 * The zod schema of `bootstrap.json` (strict objects). The JSON Schema is generated with
 * `z.toJSONSchema(BootstrapManifestSchema, { io: "input" })`.
 */
export const BootstrapManifestSchema: z.ZodType<BootstrapManifest> =
  schema as unknown as z.ZodType<BootstrapManifest>;

/**
 * Validates and parses `bootstrap.json`. Invalid input returns `{ errors }` (`<path>: <reason>`, at
 * most 50); never throws.
 */
export function parseBootstrapManifest(json: unknown): BootstrapManifest | { errors: string[] } {
  const r = BootstrapManifestSchema.safeParse(json);
  if (r.success) return r.data;
  return {
    errors: r.error.issues.slice(0, MAX_ERRORS).map((i) => {
      const path = i.path.map(String).join(".");
      return path ? `${path}: ${i.message}` : i.message;
    }),
  };
}

/** The file name of an entry's tgz in the bootstrap directory: `<name>-<version>.tgz`. */
export function bootstrapFileName(e: BootstrapEntry): string {
  return `${e.name}-${e.version}.tgz`;
}

/** Extra manifest format version. */
export const BOOTSTRAP_EXTRA_MANIFEST_SCHEMA_VERSION = 1;

/** A `git` entry: a plugin directory of a declared marketplace at a pinned commit. */
export interface BootstrapGitEntry {
  /** Catalog item name. */
  name: string;
  source: "git";
  /** A name from the manifest's `marketplaces`. */
  marketplace: string;
  /** 40-hex commit the tree is read at (never a branch). */
  commit: string;
  /** The plugin directory inside the repository: `./<path>`, or `.` / `./` for its root. */
  path: string;
  /** Exact semver. */
  version: string;
  /** `sha512-<base64>` of the kernel's canonical pack of the tree. */
  integrity: string;
  required?: boolean;
  builtin?: boolean;
}

/** An entry of the extra manifest: npm (`required` optional) or git. */
export type BootstrapExtraEntry =
  | (Omit<Extract<BootstrapEntry, { source: "npm" }>, "required"> & { required?: boolean })
  | BootstrapGitEntry;

/** A marketplace the extra manifest declares for its `git` entries. */
export interface BootstrapExtraMarketplace {
  /** `^[a-z0-9][a-z0-9-]{0,63}$`, unique, not `official`. */
  name: string;
  /** An https URL without userinfo. */
  url: string;
  ref?: string;
  /** HTTP basic username of the credential (`^[A-Za-z0-9._-]{1,64}$`). */
  username?: string;
}

/**
 * The extra bootstrap manifest (`bootstrap-extra.v1`): a second manifest a distribution supplies (the file
 * `bootstrap.extraManifest` points at), merged into the built-in one (spec 2026-11-20-bootstrap-extra-manifest §2). It adds
 * `marketplaces` the entries can name, `git` entries (a plugin directory of such a marketplace at
 * a pinned commit) and an optional `defaultTheme`. `required` is optional here (default `false`).
 * Objects are strict. The committed JSON Schema (`schemas/bootstrap-extra.v1.schema.json`) is
 * generated from {@link BootstrapExtraManifestSchema}; the cross-field rules (unique names, a
 * declared marketplace, `defaultTheme` naming a builtin entry, not both `required` and `builtin`)
 * are decided only by {@link parseBootstrapExtraManifest}.
 */
export interface BootstrapExtraManifest {
  $schema?: string;
  schemaVersion: 1;
  marketplaces: BootstrapExtraMarketplace[];
  plugins: BootstrapExtraEntry[];
  /** The platform default theme: `plugin` is a builtin entry of this manifest. */
  defaultTheme?: { plugin: string; theme: string };
}

const RESERVED_MARKETPLACE_NAME = "official";

const extraCommon = {
  name: common.name,
  version: common.version,
  integrity: common.integrity,
  required: z.boolean().optional(),
  builtin: common.builtin,
};

const extraEntry = z.discriminatedUnion("source", [
  z.strictObject({
    ...extraCommon,
    source: z.literal("npm"),
    npm: z
      .string()
      .max(214)
      .regex(NPM_PACKAGE_NAME_RE, { message: "npm must be an npm package name" }),
  }),
  z.strictObject({
    ...extraCommon,
    source: z.literal("git"),
    marketplace: common.name,
    commit: z.string().regex(COMMIT_RE, { message: "commit must be 40 hex characters" }),
    path: z
      .string()
      .max(512)
      // "." / "./": the repository root (a single-plugin repository)
      .refine(
        (p) => p === "." || p === "./" || (p.startsWith("./") && isSafePackagePath(p.slice(2))),
        {
          message:
            'path must be "." (the repository root) or start with "./" and stay inside the repository',
        },
      ),
  }),
]);

const extraMarketplace = z.strictObject({
  name: common.name,
  url: z
    .string()
    .max(URL_CHARS)
    .regex(HTTPS_URL_RE, { message: "url must be an https URL" })
    .refine(
      (s) => {
        try {
          const u = new URL(s);
          return u.username === "" && u.password === "";
        } catch {
          return false;
        }
      },
      { message: "url must be a valid URL without userinfo" },
    ),
  ref: z.string().min(1).max(256).optional(),
  username: z
    .string()
    .regex(GIT_USERNAME_RE, { message: "username must match ^[A-Za-z0-9._-]{1,64}$" })
    .optional(),
});

const extraSchema = z
  .strictObject({
    $schema: z.string().max(URL_CHARS).optional(),
    schemaVersion: z.literal(BOOTSTRAP_EXTRA_MANIFEST_SCHEMA_VERSION),
    marketplaces: z.array(extraMarketplace).max(50),
    plugins: z.array(extraEntry).max(500),
    defaultTheme: z
      .strictObject({
        plugin: common.name,
        theme: z.string().min(1).max(256),
      })
      .optional(),
  })
  .superRefine((m, ctx) => {
    const marketplaces = new Set<string>();
    m.marketplaces.forEach((mk, i) => {
      if (mk.name === RESERVED_MARKETPLACE_NAME) {
        ctx.addIssue({
          code: "custom",
          path: ["marketplaces", i, "name"],
          message: `the name ${RESERVED_MARKETPLACE_NAME} is reserved`,
        });
      }
      if (marketplaces.has(mk.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["marketplaces", i, "name"],
          message: `duplicate marketplace ${mk.name}`,
        });
      }
      marketplaces.add(mk.name);
    });
    const seen = new Set<string>();
    m.plugins.forEach((e, i) => {
      if (seen.has(e.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["plugins", i, "name"],
          message: `duplicate entry ${e.name}`,
        });
      }
      seen.add(e.name);
      if (e.required === true && e.builtin === true) {
        ctx.addIssue({
          code: "custom",
          path: ["plugins", i, "builtin"],
          message: "an entry is either required or builtin, not both",
        });
      }
      if (e.source === "git" && !marketplaces.has(e.marketplace)) {
        ctx.addIssue({
          code: "custom",
          path: ["plugins", i, "marketplace"],
          message: `marketplace "${e.marketplace}" is not declared`,
        });
      }
    });
    if (m.defaultTheme !== undefined) {
      const target = m.plugins.find((e) => e.name === m.defaultTheme?.plugin);
      if (target === undefined || target.builtin !== true) {
        ctx.addIssue({
          code: "custom",
          path: ["defaultTheme", "plugin"],
          message: "must name an entry of this manifest with builtin: true",
        });
      }
    }
  });

/**
 * The zod schema of the extra manifest (strict objects). The JSON Schema is generated with
 * `z.toJSONSchema(BootstrapExtraManifestSchema, { io: "input" })`.
 */
export const BootstrapExtraManifestSchema: z.ZodType<BootstrapExtraManifest> =
  extraSchema as unknown as z.ZodType<BootstrapExtraManifest>;

// Compile-time guard: the hand-written interfaces and the zod schema must not drift apart.
type Assert<T extends true> = T;
// (Checked in the interface -> schema direction: zod writes optional keys as `?: T | undefined`,
// which `exactOptionalPropertyTypes` does not accept in the other direction.)
type _BootstrapExtraManifestMatchesSchema = Assert<
  BootstrapExtraManifest extends z.input<typeof extraSchema> ? true : false
>;

/**
 * Validates and parses the extra manifest. Invalid input returns `{ errors }` (`<path>: <reason>`,
 * at most 50); never throws.
 */
export function parseBootstrapExtraManifest(
  json: unknown,
): { manifest: BootstrapExtraManifest } | { errors: string[] } {
  const r = BootstrapExtraManifestSchema.safeParse(json);
  if (r.success) return { manifest: r.data };
  return {
    errors: r.error.issues.slice(0, MAX_ERRORS).map((i) => {
      const path = i.path.map(String).join(".");
      return path ? `${path}: ${i.message}` : i.message;
    }),
  };
}
