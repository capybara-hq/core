import { createHash } from "node:crypto";
import {
  CATALOG_ITEM_NAME_RE,
  CONNECTOR_TEMPLATE_LIMITS,
  type ConnectorTemplateFile,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MANIFEST_LIMITS,
  type PluginManifest,
  parseConnectorTemplateFile,
  parsePluginManifest,
  parseSkillMd,
  SKILL_ENTRY_FILE,
  validatePluginPackageJsonFor,
} from "@capybara-hq/plugin-sdk";
import {
  HOST_ZOD_VERSION,
  LEGACY_FORMAT_MESSAGE,
  PackageTgzError,
  type PackageTgzLimits,
  packagePath,
  parsePackageJsonFile,
  unpackPackageTgz,
} from "../packages/tgz.js";

export { LEGACY_FORMAT_MESSAGE, packagePath };

/**
 * Reads a plugin tgz (spec §4.1): `package/.capybara-plugin/plugin.json` plus the skills, connector
 * templates and extension it describes. The tgz is untrusted input and is unpacked by the extension
 * package tgz rules (`packages/tgz.ts` {@link unpackPackageTgz}: size, decompression cap, entry
 * count, regular files only, safe paths under `package/`). No code from the package runs here; the extension's module graph is
 * checked by `readExtensionPackage`.
 *
 * A tgz in the pre-0.1.0 format (a `capybara` section in package.json, or `app.yaml`, and no
 * plugin.json) is rejected first, with {@link LEGACY_FORMAT_MESSAGE}: there is no reader for the
 * old formats.
 */

/** Codes of {@link PluginPackageError}. */
export type PluginPackageErrorCode = "catalog.invalid_manifest" | "catalog.legacy_format";

/** The plugin package is invalid; `issues` lists the problems (English, shown to the admin). */
export class PluginPackageError extends Error {
  readonly code: PluginPackageErrorCode;
  readonly issues: string[];
  constructor(code: PluginPackageErrorCode, issues: string[]) {
    super(
      code === "catalog.legacy_format"
        ? (issues[0] ?? LEGACY_FORMAT_MESSAGE)
        : `Invalid plugin package: ${issues[0] ?? "unknown problem"}`,
    );
    this.name = "PluginPackageError";
    this.code = code;
    this.issues = issues;
  }
}

/** A skill of the plugin. `dir` is relative to the package root; `files` are relative to `dir`. */
export interface PluginPackageSkill {
  name: string;
  dir: string;
  files: string[];
}

/** A connector template of the plugin; `id` is the file's base name. */
export interface PluginPackageConnectorTemplate {
  id: string;
  /** Relative to the package root (no leading `./`). */
  path: string;
  file: ConnectorTemplateFile;
}

/** A read and validated plugin package. Paths are relative to the package root (no `package/`). */
export interface PluginPackage {
  /** Hex sha256 of the whole tgz. */
  sha256: string;
  /** tgz bytes. */
  size: number;
  packageJson: Record<string, unknown>;
  manifest: PluginManifest;
  files: Map<string, Uint8Array>;
  skills: PluginPackageSkill[];
  connectorTemplates: PluginPackageConnectorTemplate[];
}

/** Options of {@link readPluginPackage}; `hostZodVersion` defaults to the kernel's zod. */
export interface ReadPluginPackageOptions extends PackageTgzLimits {
  hostSdkVersion: string;
  hostZodVersion?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const decode = (data: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
};

/** Largest icon (plugin or connector template) in bytes. */
export const PLUGIN_ICON_MAX_BYTES = CONNECTOR_TEMPLATE_LIMITS.iconBytes;

/**
 * Whether an icon really is an svg / png (only the file header and UTF-8 text are looked at, nothing
 * is rendered) within {@link PLUGIN_ICON_MAX_BYTES}; undefined when it is.
 */
export function iconProblem(path: string, data: Uint8Array): string | undefined {
  if (data.byteLength > PLUGIN_ICON_MAX_BYTES) {
    return `${path} is larger than ${PLUGIN_ICON_MAX_BYTES} bytes`;
  }
  if (/\.png$/i.test(path)) {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return sig.every((b, i) => data[i] === b) ? undefined : `${path} is not a PNG image`;
  }
  const text = decode(data);
  if (text === undefined) return `${path} is not a UTF-8 SVG document`;
  return /<svg[\s>/]/i.test(text) ? undefined : `${path} is not an SVG document`;
}

/** package.json parsed, or undefined when it is not valid (only used to name a legacy package). */
const parsedOrUndefined = (data: Uint8Array): unknown => {
  try {
    return parsePackageJsonFile({ data });
  } catch (e) {
    if (e instanceof PackageTgzError) return undefined;
    throw e;
  }
};

const invalid = (issues: string[]): never => {
  throw new PluginPackageError("catalog.invalid_manifest", issues);
};

/** Runs a step that reports problems as {@link PackageTgzError} (unpacking, package.json). */
async function step<T>(f: () => T | Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof PackageTgzError) return invalid(e.issues);
    throw e;
  }
}

/**
 * Reads and validates a plugin tgz (see the file header). Invalid -> {@link PluginPackageError}:
 * `catalog.legacy_format` for the pre-0.1.0 format, otherwise `catalog.invalid_manifest` listing
 * every problem it can find, each naming the path it is about (unpacking and manifest parse
 * problems stop at the first stage that fails).
 */
export async function readPluginPackage(
  bytes: Uint8Array,
  opts: ReadPluginPackageOptions,
): Promise<PluginPackage> {
  const unpacked = await step(() => unpackPackageTgz(bytes, opts));
  const files = new Map<string, Uint8Array>(unpacked.map((f) => [f.path, f.data]));

  const pj = files.get("package.json");
  const manifestBytes = files.get(PLUGIN_MANIFEST_FILE);
  if (manifestBytes === undefined) {
    // The old formats are recognised only to say so; nothing in them is read. app.yaml is checked
    // before package.json is parsed, so an old bundle with a broken package.json is still legacy.
    const pkg = pj && parsedOrUndefined(pj);
    if (files.has("app.yaml") || (isObj(pkg) && pkg.capybara !== undefined)) {
      const who =
        isObj(pkg) && typeof pkg.name === "string" ? `Package ${pkg.name}` : "The package";
      throw new PluginPackageError("catalog.legacy_format", [`${who} ${LEGACY_FORMAT_MESSAGE}`]);
    }
    if (pj) await step(() => parsePackageJsonFile({ data: pj }));
    return invalid([`${PLUGIN_MANIFEST_FILE} not found in the package (the plugin manifest)`]);
  }

  const packageJson = await step(() => parsePackageJsonFile(pj && { data: pj }));

  const text = decode(manifestBytes);
  if (text === undefined) return invalid([`${PLUGIN_MANIFEST_FILE} is not valid UTF-8 text`]);
  const parsed = parsePluginManifest(text);
  if ("errors" in parsed) return invalid(parsed.errors.map((e) => `${PLUGIN_MANIFEST_FILE}: ${e}`));
  const manifest = parsed;

  const issues = validatePluginPackageJsonFor(packageJson, manifest, opts.hostSdkVersion, {
    hostZodVersion: opts.hostZodVersion ?? HOST_ZOD_VERSION,
  });
  const under = (dir: string) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`));

  // Skills: listed, or scanned from skills/*/SKILL.md.
  const skillDirs: string[] = [];
  if (manifest.skills !== undefined) {
    manifest.skills.forEach((s, i) => {
      const dir = packagePath(s.path);
      if (!files.has(`${dir}/${SKILL_ENTRY_FILE}`)) {
        issues.push(`skills.${i}: ${s.path}/${SKILL_ENTRY_FILE} not found in the package`);
      } else skillDirs.push(dir);
    });
  } else {
    const re = new RegExp(`^(skills/[^/]+)/${SKILL_ENTRY_FILE}$`);
    for (const p of [...files.keys()].sort()) {
      const m = re.exec(p);
      if (m) skillDirs.push(m[1] as string);
    }
    if (skillDirs.length > PLUGIN_MANIFEST_LIMITS.skills) {
      issues.push(
        `skills/ holds ${skillDirs.length} skills; a plugin may have at most ${PLUGIN_MANIFEST_LIMITS.skills}`,
      );
    }
  }
  const skills: PluginPackageSkill[] = [];
  const skillNames = new Map<string, string>();
  for (const dir of skillDirs) {
    const path = `${dir}/${SKILL_ENTRY_FILE}`;
    const md = decode(files.get(path) as Uint8Array);
    if (md === undefined) {
      issues.push(`${path}: not valid UTF-8 text`);
      continue;
    }
    const r = parseSkillMd(md);
    if ("errors" in r) {
      issues.push(...r.errors.map((e) => `${path}: ${e}`));
      continue;
    }
    const other = skillNames.get(r.name);
    if (other !== undefined) {
      issues.push(`${path}: skill name "${r.name}" is also used by ${other}/${SKILL_ENTRY_FILE}`);
      continue;
    }
    skillNames.set(r.name, dir);
    skills.push({
      name: r.name,
      dir,
      files: under(dir)
        .map((p) => p.slice(dir.length + 1))
        .sort(),
    });
  }

  // Connector templates: listed, or scanned from connectors/*.json.
  const templatePaths: string[] = [];
  if (manifest.connectorTemplates !== undefined) {
    manifest.connectorTemplates.forEach((t, i) => {
      const path = packagePath(t.path);
      if (!files.has(path)) {
        issues.push(`connectorTemplates.${i}: ${t.path} not found in the package`);
      } else templatePaths.push(path);
    });
  } else {
    for (const p of [...files.keys()].sort()) {
      if (/^connectors\/[^/]+\.json$/.test(p)) templatePaths.push(p);
    }
    if (templatePaths.length > PLUGIN_MANIFEST_LIMITS.connectorTemplates) {
      issues.push(
        `connectors/ holds ${templatePaths.length} connector templates; a plugin may have at most ${PLUGIN_MANIFEST_LIMITS.connectorTemplates}`,
      );
    }
  }
  const connectorTemplates: PluginPackageConnectorTemplate[] = [];
  for (const path of templatePaths) {
    const id = (path.split("/").pop() as string).replace(/\.json$/, "");
    if (!CATALOG_ITEM_NAME_RE.test(id)) {
      issues.push(`${path}: the template id "${id}" must match ^[a-z0-9][a-z0-9-]{0,63}$`);
      continue;
    }
    const json = decode(files.get(path) as Uint8Array);
    if (json === undefined) {
      issues.push(`${path}: not valid JSON`);
      continue;
    }
    // Pass the text so the file gets the same size limit and BOM handling as plugin.json.
    const r = parseConnectorTemplateFile(json);
    if ("errors" in r) {
      issues.push(...r.errors.map((e) => `${path}: ${e}`));
      continue;
    }
    if (r.icon !== undefined) {
      const icon = files.get(packagePath(r.icon));
      const problem =
        icon === undefined ? `${r.icon} not found in the package` : iconProblem(r.icon, icon);
      if (problem !== undefined) issues.push(`${path}: icon ${problem}`);
    }
    connectorTemplates.push({ id, path, file: r });
  }

  if (manifest.icon !== undefined) {
    const icon = files.get(packagePath(manifest.icon));
    const problem =
      icon === undefined
        ? `${manifest.icon} not found in the package`
        : iconProblem(manifest.icon, icon);
    if (problem !== undefined) issues.push(`icon: ${problem}`);
  }

  const ext = manifest.extension;
  if (ext !== undefined) {
    if (!files.has(packagePath(ext.entry))) {
      issues.push(`extension.entry: ${ext.entry} not found in the package`);
    }
    for (const k of ["migrations", "ui"] as const) {
      const dir = ext[k];
      if (dir !== undefined && under(packagePath(dir)).length === 0) {
        issues.push(`extension.${k}: directory ${dir} is missing or empty`);
      }
    }
  } else if (skillDirs.length === 0 && templatePaths.length === 0) {
    issues.push("a plugin must contain an extension, a skill or a connector template");
  }

  if (issues.length > 0) invalid(issues);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    packageJson: packageJson as Record<string, unknown>,
    manifest,
    files,
    skills,
    connectorTemplates,
  };
}
