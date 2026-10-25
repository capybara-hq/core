import { z } from "zod";
import {
  CATALOG_ITEM_NAME_RE,
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
 * the official plugins are published: `path` is packed with `tools/pack-plugin`, which is
 * byte-reproducible, and `integrity` is that pack's sha512).
 *
 * Objects are strict (unknown keys rejected, `$schema` allowed): the manifest ships with core, so
 * there is no older reader to stay compatible with and a misspelt key is a mistake. The committed
 * JSON Schema (`schemas/bootstrap.v1.schema.json`) is generated from {@link BootstrapManifestSchema}
 * by `pnpm gen:package-schemas`; the cross-field rules (unique names, `marketplace` required with an
 * npm entry) are decided only by {@link parseBootstrapManifest}.
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
    }
  | {
      name: string;
      source: "workspace";
      /** `plugins/<dir>`, relative to the repository root. */
      path: string;
      version: string;
      integrity: string;
      required: boolean;
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
