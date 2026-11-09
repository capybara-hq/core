import { isSafePackagePath } from "./plugin-package.js";

/**
 * The client section of a plugin's extension (client extensions spec §4.1): the browser bundle, CSS
 * files and assets under `./dist/client/`, each pinned by a sha384 integrity. Written by the packer.
 */
export interface PluginClientSection {
  /** `./dist/client/client.mjs`; absent for CSS-only decoration. */
  entry?: string;
  /** `./dist/client/styles/<name>.css`, in injection order. */
  styles?: string[];
  /** `./dist/client/assets/<path>`. */
  assets?: string[];
  /** sha384 of every file above, keyed by its path: `sha384-<base64>`. */
  integrity: Record<string, string>;
  /** {@link CLIENT_API_VERSION} the bundle was built against. */
  apiVersion: number;
}

/** The client API version the host provides (`@capybara-hq/plugin-client` carries the same number). */
export const CLIENT_API_VERSION = 1;

/** Limits of client code (client extensions spec §4.1, §10). */
export const CLIENT_LIMITS = {
  entryBytes: 1048576,
  styleFiles: 8,
  styleBytes: 262144,
  assetFiles: 64,
  assetBytes: 2097152,
  totalBytes: 8388608,
  loadTimeoutMs: 10000,
  pendingMs: 1500,
  crashBudget: 3,
} as const;

/** Allowed asset extensions and the content type each is served with. */
export const CLIENT_ASSET_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

export const CLIENT_ENTRY_PATH = "./dist/client/client.mjs";
const STYLE_RE = /^\.\/dist\/client\/styles\/[A-Za-z0-9][A-Za-z0-9._-]*\.css$/;
const ASSET_PREFIX = "./dist/client/assets/";
/** One segment of an asset path: URL-safe characters only (the kernel's delivery key charset). */
const ASSET_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const INTEGRITY_RE = /^sha384-[A-Za-z0-9+/]{64}$/;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Checks a client section (`parsePluginManifest` and the packer use it); returns the problems. */
export function validateClientSection(s: unknown): string[] {
  if (s === null || typeof s !== "object" || Array.isArray(s)) return ["client must be an object"];
  const o = s as Record<string, unknown>;
  const errs: string[] = [];
  for (const k of Object.keys(o)) {
    if (!["entry", "styles", "assets", "integrity", "apiVersion"].includes(k)) {
      errs.push(`client.${k} is not a known field`);
    }
  }
  const listed: string[] = [];
  if (o.entry !== undefined) {
    if (o.entry !== CLIENT_ENTRY_PATH) errs.push(`client.entry must be ${CLIENT_ENTRY_PATH}`);
    else listed.push(o.entry);
  }
  let styleCount = 0;
  if (o.styles !== undefined) {
    if (!isStringArray(o.styles)) errs.push("client.styles must be an array of strings");
    else {
      styleCount = o.styles.length;
      if (styleCount > CLIENT_LIMITS.styleFiles) {
        errs.push(
          `client.styles has ${styleCount} files; the limit is ${CLIENT_LIMITS.styleFiles}`,
        );
      }
      for (const p of o.styles) {
        if (!STYLE_RE.test(p)) {
          errs.push(`client.styles: ${p} must be ./dist/client/styles/<name>.css`);
        } else if (listed.includes(p)) errs.push(`client.styles: duplicate ${p}`);
        else listed.push(p);
      }
    }
  }
  if (o.assets !== undefined) {
    if (!isStringArray(o.assets)) errs.push("client.assets must be an array of strings");
    else {
      if (o.assets.length > CLIENT_LIMITS.assetFiles) {
        errs.push(
          `client.assets has ${o.assets.length} files; the limit is ${CLIENT_LIMITS.assetFiles}`,
        );
      }
      for (const p of o.assets) {
        const rest = p.startsWith(ASSET_PREFIX) ? p.slice(ASSET_PREFIX.length) : null;
        if (rest === null || !isSafePackagePath(rest)) {
          errs.push(`client.assets: ${p} must be a safe path under ${ASSET_PREFIX}`);
          continue;
        }
        // the kernel looks a file up by its exact key, never decoding the URL (`%2e%2e` names no
        // file there), so every segment uses the URL-safe characters only
        if (!rest.split("/").every((seg) => ASSET_SEGMENT_RE.test(seg))) {
          errs.push(`client.assets: ${p} must use letters, digits, . _ - in each path segment`);
          continue;
        }
        const name = rest.slice(rest.lastIndexOf("/") + 1);
        const dot = name.lastIndexOf(".");
        if (dot === 0) {
          errs.push(`client.assets: ${p} needs a file name before the extension`);
          continue;
        }
        const ext = dot < 0 ? "" : name.slice(dot).toLowerCase();
        if (!Object.hasOwn(CLIENT_ASSET_TYPES, ext)) {
          errs.push(
            `client.assets: ${p} has an unsupported type; allowed: ${Object.keys(CLIENT_ASSET_TYPES).join(" ")}`,
          );
        } else if (listed.includes(p)) errs.push(`client.assets: duplicate ${p}`);
        else listed.push(p);
      }
    }
  }
  if (o.entry === undefined && styleCount === 0) {
    errs.push("client needs an entry or at least one style file");
  }
  const integ = o.integrity;
  if (integ === null || typeof integ !== "object" || Array.isArray(integ)) {
    errs.push("client.integrity must be an object");
  } else {
    const map = integ as Record<string, unknown>;
    for (const p of listed) {
      const v = map[p];
      if (v === undefined) errs.push(`client.integrity: missing entry for ${p}`);
      else if (typeof v !== "string" || !INTEGRITY_RE.test(v)) {
        errs.push(`client.integrity: ${p} must be sha384-<base64>`);
      }
    }
    for (const p of Object.keys(map)) {
      if (!listed.includes(p)) errs.push(`client.integrity: ${p} is not a listed file`);
    }
  }
  if (typeof o.apiVersion !== "number" || !Number.isInteger(o.apiVersion) || o.apiVersion < 1) {
    errs.push("client.apiVersion must be a positive integer");
  }
  return errs;
}
