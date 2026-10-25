import { z } from "zod";
import {
  CATALOG_ITEM_NAME_RE,
  isSafePackagePath,
  NPM_PACKAGE_NAME_RE,
  SEMVER_VERSION_RE,
  SHA512_INTEGRITY_RE,
} from "./plugin-package.js";

/**
 * The marketplace manifest `marketplace.json` (package ecosystem spec §5.2): a list of plugins,
 * each with one source. One entry is one version: a marketplace that offers several versions lists
 * the plugin once per version, so `(name, marketplaceEntryVersion)` is unique in a manifest.
 *
 * Sources: a same-repo `path`, a `git` repo, an `npm` package (exact version + sha512, downloads
 * are verified against it, never npm metadata) or an `archive` URL (sha512 or sha256 SRI).
 *
 * The committed JSON Schema (`schemas/marketplace.v1.schema.json`) is generated from
 * {@link MarketplaceManifestSchema} by `pnpm gen:package-schemas` and drift-checked by
 * `check:package-schemas`. Cross-field rules (unique `(name, version)`, `version` equal to the npm
 * source's, `sensitive` ⊆ `keys`) are decided only by {@link parseMarketplaceManifest}. Unknown
 * fields are dropped (forward compatible: a newer manifest does not make an older kernel reject it).
 */

/** Manifest format version. */
export const MARKETPLACE_MANIFEST_SCHEMA_VERSION = 1;

/** Limits of the marketplace manifest. */
export const MARKETPLACE_LIMITS = {
  nameChars: 100,
  summaryChars: 280,
  plugins: 5000,
  permissionKeys: 500,
  urlChars: 2000,
} as const;

/** Where a marketplace entry's plugin comes from. */
export type MarketplaceSource =
  | { path: string }
  | { git: { url: string; ref?: string; commit?: string; path?: string } }
  | { npm: { package: string; version: string; integrity: string } }
  | { archive: { url: string; integrity: string } };

/** One plugin version listed by a marketplace. */
export interface MarketplaceEntry {
  /** Catalog item name (`^[a-z0-9][a-z0-9-]{0,63}$`). */
  name: string;
  summary: { en: string; zh?: string };
  /** Exact semver; defaults to the npm source's version, otherwise the plugin's own. */
  version?: string;
  /** Exact semver. */
  minKernel?: string;
  /** Display only (a mismatch with the computed permissions warns, never rejects). */
  permissions?: { keys: string[]; sensitive: string[] };
  /** https URL. */
  homepage?: string;
  source: MarketplaceSource;
}

/** `marketplace.json`. */
export interface MarketplaceManifest {
  $schema?: string;
  schemaVersion: 1;
  /** Display name, unrelated to the repo name. */
  name: string;
  owner?: { name: string; url?: string };
  description?: string;
  plugins: MarketplaceEntry[];
}

export interface MarketplaceParseOptions {
  /** Tests only: allow http on loopback addresses for `git` / `archive` URLs. */
  allowInsecureLoopback?: boolean;
}

const M = MARKETPLACE_LIMITS;
const MAX_ERRORS = 50;
/** Kernel permission key format: `<category>[:<value>]`, the category lowercase letters and dots. */
const PERMISSION_KEY_RE = /^[a-z][a-z.]{0,62}(?::[^\r\n]{1,256})?$/;
const SHA256_INTEGRITY_RE = /^sha256-[A-Za-z0-9+/]{43}=$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const HTTPS_URL_RE = /^https:\/\/\S+$/;
const HTTPS_OR_LOOPBACK_RE =
  /^(?:https:\/\/\S+|http:\/\/(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(?::\d{1,5})?(?:\/\S*)?)$/;

const urlString = (re: RegExp) =>
  z
    .string()
    .max(M.urlChars)
    .regex(re, { message: "must be an https URL" })
    .refine(
      (s) => {
        try {
          new URL(s);
          return true;
        } catch {
          return false;
        }
      },
      { message: "must be a valid URL" },
    );

const exactVersion = (what: string) =>
  z
    .string()
    .max(256)
    .regex(SEMVER_VERSION_RE, { message: `${what} must be an exact semver version` });

/** `./<safe path>` inside the marketplace repo. */
const repoPath = z
  .string()
  .max(512)
  .refine((p) => p.startsWith("./") && isSafePackagePath(p.slice(2)), {
    message: 'path must start with "./" and stay inside the repository',
  });
/** A path inside a git repo: `.` (the root) or a safe relative path with an optional `./`. */
const gitPath = z
  .string()
  .max(512)
  .refine((p) => p === "." || isSafePackagePath(p.replace(/^\.\//, "")), {
    message: "path must be . or a relative path inside the repository",
  });

function buildSchema(opts: MarketplaceParseOptions) {
  const url = urlString(opts.allowInsecureLoopback ? HTTPS_OR_LOOPBACK_RE : HTTPS_URL_RE);
  const none = z.never().optional();
  // Exactly one form: each object declares the other forms' keys as absent.
  const source = z.union([
    z.object({ path: repoPath, git: none, npm: none, archive: none }),
    z.object({
      git: z.object({
        url,
        ref: z.string().min(1).max(256).optional(),
        commit: z
          .string()
          .regex(COMMIT_RE, { message: "commit must be 40 hex characters" })
          .optional(),
        path: gitPath.optional(),
      }),
      path: none,
      npm: none,
      archive: none,
    }),
    z.object({
      npm: z.object({
        package: z
          .string()
          .max(214)
          .regex(NPM_PACKAGE_NAME_RE, { message: "package must be an npm package name" }),
        version: exactVersion("version"),
        integrity: z
          .string()
          .regex(SHA512_INTEGRITY_RE, { message: "integrity must be sha512-<86 base64 chars>==" }),
      }),
      path: none,
      git: none,
      archive: none,
    }),
    z.object({
      archive: z.object({
        url,
        integrity: z
          .string()
          .refine((s) => SHA512_INTEGRITY_RE.test(s) || SHA256_INTEGRITY_RE.test(s), {
            message: "integrity must be a sha512- or sha256- SRI",
          }),
      }),
      path: none,
      git: none,
      npm: none,
    }),
  ]);
  const permissionKey = z.string().max(300).regex(PERMISSION_KEY_RE, {
    message: "must be a permission key (<category>[:<value>])",
  });
  const entry = z.object({
    name: z
      .string()
      .regex(CATALOG_ITEM_NAME_RE, { message: "name must match ^[a-z0-9][a-z0-9-]{0,63}$" }),
    summary: z.object({
      en: z.string().min(1).max(M.summaryChars),
      zh: z.string().min(1).max(M.summaryChars).optional(),
    }),
    version: exactVersion("version").optional(),
    minKernel: exactVersion("minKernel").optional(),
    permissions: z
      .object({
        keys: z.array(permissionKey).max(M.permissionKeys),
        sensitive: z.array(permissionKey).max(M.permissionKeys),
      })
      .optional(),
    homepage: urlString(HTTPS_URL_RE).optional(),
    source,
  });
  return z
    .object({
      $schema: z.string().max(M.urlChars).optional(),
      schemaVersion: z.literal(MARKETPLACE_MANIFEST_SCHEMA_VERSION),
      name: z.string().min(1).max(M.nameChars),
      owner: z
        .object({
          name: z.string().min(1).max(M.nameChars),
          url: urlString(HTTPS_URL_RE).optional(),
        })
        .optional(),
      description: z.string().min(1).max(1024).optional(),
      plugins: z.array(entry).max(M.plugins),
    })
    .superRefine((m, ctx) => {
      const seen = new Set<string>();
      m.plugins.forEach((raw, i) => {
        const e = raw as MarketplaceEntry;
        const v = marketplaceEntryVersion(e);
        const key = `${e.name} ${v ?? "(no version)"}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["plugins", i, "name"],
            message: `duplicate entry ${key}`,
          });
        }
        seen.add(key);
        if (
          "npm" in e.source &&
          e.source.npm &&
          e.version !== undefined &&
          e.version !== e.source.npm.version
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["plugins", i, "version"],
            message: `version ${e.version} must equal source.npm.version ${e.source.npm.version}`,
          });
        }
        if (e.permissions) {
          const keys = new Set(e.permissions.keys);
          for (const s of e.permissions.sensitive) {
            if (!keys.has(s)) {
              ctx.addIssue({
                code: "custom",
                path: ["plugins", i, "permissions", "sensitive"],
                message: `sensitive key "${s}" is not in keys`,
              });
            }
          }
        }
      });
    });
}

/**
 * The zod schema of `marketplace.json` (https only; non-strict: unknown fields dropped). The JSON
 * Schema is generated with `z.toJSONSchema(MarketplaceManifestSchema, { io: "input" })`.
 */
export const MarketplaceManifestSchema: z.ZodType<MarketplaceManifest> = buildSchema(
  {},
) as unknown as z.ZodType<MarketplaceManifest>;

const LOOPBACK_SCHEMA = buildSchema({
  allowInsecureLoopback: true,
}) as unknown as z.ZodType<MarketplaceManifest>;

/** Strips the absent-form keys zod leaves as `undefined` on the parsed source. */
function cleanSource(s: Record<string, unknown>): MarketplaceSource {
  return Object.fromEntries(
    Object.entries(s).filter(([, v]) => v !== undefined),
  ) as unknown as MarketplaceSource;
}

/**
 * Validates and parses `marketplace.json` (unknown fields dropped). Invalid input returns
 * `{ errors }` (`<path>: <reason>`, at most 50); never throws.
 */
export function parseMarketplaceManifest(
  json: unknown,
  opts: MarketplaceParseOptions = {},
): MarketplaceManifest | { errors: string[] } {
  const r = (opts.allowInsecureLoopback ? LOOPBACK_SCHEMA : MarketplaceManifestSchema).safeParse(
    json,
  );
  if (r.success) {
    return {
      ...r.data,
      plugins: r.data.plugins.map((e) => ({
        ...e,
        source: cleanSource(e.source as unknown as Record<string, unknown>),
      })),
    };
  }
  return {
    errors: r.error.issues
      .flatMap((i) => explainSource(json, i))
      .slice(0, MAX_ERRORS)
      .map((i) => {
        const path = i.path.map(String).join(".");
        return path ? `${path}: ${i.message}` : i.message;
      }),
  };
}

const SOURCE_FORMS = ["path", "git", "npm", "archive"] as const;
type Issue = { path: PropertyKey[]; message: string };

/**
 * A failed `source` union is reported by zod as a bare "Invalid input"; report the problems of the
 * form the source uses instead, or that it must use exactly one form.
 */
function explainSource(json: unknown, issue: z.core.$ZodIssue): Issue[] {
  if (issue.code !== "invalid_union" || issue.path[issue.path.length - 1] !== "source") {
    return [issue];
  }
  let v: unknown = json;
  for (const k of issue.path) v = (v as Record<PropertyKey, unknown> | undefined)?.[k];
  const used =
    v !== null && typeof v === "object"
      ? SOURCE_FORMS.filter((f) => (v as Record<string, unknown>)[f] !== undefined)
      : [];
  const branch =
    used.length === 1 ? SOURCE_FORMS.indexOf(used[0] as (typeof SOURCE_FORMS)[number]) : -1;
  const branchIssues = branch >= 0 ? issue.errors[branch] : undefined;
  if (!branchIssues || branchIssues.length === 0) {
    return [{ path: issue.path, message: `must have exactly one of ${SOURCE_FORMS.join(", ")}` }];
  }
  return branchIssues.map((b) => ({ path: [...issue.path, ...b.path], message: b.message }));
}

/** The entry's version: `version`, else the npm source's version, else `null` (the plugin's own). */
export function marketplaceEntryVersion(e: MarketplaceEntry): string | null {
  if (e.version !== undefined) return e.version;
  if ("npm" in e.source) return e.source.npm.version;
  return null;
}
