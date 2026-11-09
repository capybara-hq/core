import { createHash } from "node:crypto";
import {
  CLIENT_ASSET_TYPES,
  CLIENT_ENTRY_PATH,
  CLIENT_LIMITS,
  type PluginClientSection,
  validateClientSection,
} from "@capybara-hq/plugin-sdk";
import { ApiError } from "../errors.js";
import { clientCssProblem } from "./client-css.js";

/**
 * The client files of a plugin package (client extensions spec §4.1, §9.1), checked against its
 * `extension.client` section: the import review and the store both run {@link checkClientFiles} on
 * the bytes they hold, so nothing reaches object storage, and no integrity reaches a browser, that
 * was not recomputed from the bytes.
 *
 * Files are known only by their manifest key (`./dist/client/<path>`): the object key and, later,
 * the delivery lookup use the exact key, never a decoded or joined path. A key the lookup could
 * read two ways (`%`, a `.` / `..` / empty segment, a backslash, an empty file stem) is refused
 * here even when the SDK validator lets it through.
 */

/** The directory of client files inside the package (relative to the package root). */
export const CLIENT_DIR = "dist/client/";

const KEY_PREFIX = `./${CLIENT_DIR}`;

/** The object prefix of a build, relative to `deployment/`: `platform/client/<plugin>/<sha256>/`. */
export const clientBuildPrefix = (plugin: string, sha256: string) =>
  `platform/client/${plugin}/${sha256}/`;

/** The path of a manifest key inside `dist/client/` (`./dist/client/styles/a.css` -> `styles/a.css`). */
export const clientRelPath = (key: string) => key.slice(KEY_PREFIX.length);

/** The content type a client file is stored and served with (by its manifest key). */
export function clientContentType(key: string): string {
  if (key === CLIENT_ENTRY_PATH) return "text/javascript";
  if (key.endsWith(".css")) return "text/css";
  const dot = key.lastIndexOf(".");
  return CLIENT_ASSET_TYPES[key.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/** One checked client file. */
export interface CheckedClientFile {
  /** The manifest key (`./dist/client/...`). */
  key: string;
  data: Uint8Array;
  size: number;
  /** `sha384-<base64>`, equal to the section's value. */
  integrity: string;
}

/** The checked client files of a section, in section order (entry, styles, assets). */
export interface CheckedClient {
  files: CheckedClientFile[];
  total: number;
}

const invalid = (file: string, reason: string) =>
  new ApiError("client.invalid", `The plugin's client file ${file} is invalid: ${reason}`, [
    { file, reason },
  ]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Why a manifest key cannot be stored and looked up by its exact spelling, or undefined. */
function keyProblem(key: string): string | undefined {
  if (!key.startsWith(KEY_PREFIX)) return `it must be under ${KEY_PREFIX}`;
  const rel = clientRelPath(key);
  if (rel.includes("%")) return "the path contains %; use plain characters";
  if (rel.includes("\\")) return "the path contains a backslash";
  if (rel.includes("${")) return "the path contains ${";
  if (CONTROL_RE.test(rel)) return "the path contains a control character";
  const segs = rel.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) {
    return "the path has an empty, . or .. segment";
  }
  const name = segs[segs.length - 1] as string;
  if (name.lastIndexOf(".") <= 0) return "the file name has an empty stem or no extension";
  return undefined;
}

const sha384 = (data: Uint8Array) => `sha384-${createHash("sha384").update(data).digest("base64")}`;

const utf8 = (data: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
};

/**
 * Checks the client files of a package against its section and returns them. `files` holds the
 * package's files keyed by their path relative to the package root (`dist/client/client.mjs`);
 * files outside `dist/client/` are ignored. Refuses the whole package with:
 * - `client.invalid` (details `[{ file, reason }]`): the section fails `validateClientSection`
 *   (file `plugin.json`), a key cannot be looked up exactly, a listed file is missing, a file
 *   under `dist/client/` is not listed, a size limit is exceeded, or a stylesheet fails the CSS
 *   check (`client-css.ts`);
 * - `client.integrity_mismatch` (details `[{ file }]`): a file's sha384 is not the section's.
 */
export function checkClientFiles(
  section: PluginClientSection,
  files: ReadonlyMap<string, Uint8Array>,
): CheckedClient {
  const sectionIssues = validateClientSection(section);
  if (sectionIssues.length > 0) {
    throw invalid("plugin.json", sectionIssues[0] as string);
  }
  const styles = section.styles ?? [];
  const keys = [
    ...(section.entry !== undefined ? [section.entry] : []),
    ...styles,
    ...(section.assets ?? []),
  ];
  for (const key of keys) {
    const problem = keyProblem(key);
    if (problem !== undefined) throw invalid(key, problem);
  }
  const listed = new Set(keys);
  for (const path of [...files.keys()].sort()) {
    if (path.startsWith(CLIENT_DIR) && !listed.has(`./${path}`)) {
      throw invalid(`./${path}`, "the file is not listed in the plugin's client section");
    }
  }
  const out: CheckedClientFile[] = [];
  let total = 0;
  for (const key of keys) {
    const data = files.get(key.slice(2));
    if (data === undefined) throw invalid(key, "the file is missing from the package");
    const size = data.byteLength;
    const limit =
      key === section.entry
        ? CLIENT_LIMITS.entryBytes
        : styles.includes(key)
          ? CLIENT_LIMITS.styleBytes
          : CLIENT_LIMITS.assetBytes;
    if (size > limit) throw invalid(key, `the file is ${size} bytes; the limit is ${limit}`);
    total += size;
    const integrity = sha384(data);
    if (integrity !== section.integrity[key]) {
      throw new ApiError(
        "client.integrity_mismatch",
        `The plugin's client file ${key} does not match the integrity recorded in its plugin.json`,
        [{ file: key }],
      );
    }
    if (styles.includes(key)) {
      const css = utf8(data);
      if (css === undefined) throw invalid(key, "the stylesheet is not valid UTF-8 text");
      const problem = clientCssProblem(css);
      if (problem !== undefined) throw invalid(key, problem);
    }
    out.push({ key, data, size, integrity });
  }
  if (total > CLIENT_LIMITS.totalBytes) {
    throw invalid(
      "plugin.json",
      `the client files are ${total} bytes in total; the limit is ${CLIENT_LIMITS.totalBytes}`,
    );
  }
  return { files: out, total };
}
