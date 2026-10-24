import { createHash } from "node:crypto";
import {
  CATALOG_ITEM_NAME_RE,
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
  ExtensionPackageError,
  type ExtensionPackageLimits,
  HOST_ZOD_VERSION,
  parsePackageJsonFile,
  unpackPackageTgz,
} from "../extensions/package.js";

/**
 * Reads a plugin tgz (spec §4.1): `package/.capybara-plugin/plugin.json` plus the skills, connector
 * templates and extension it describes. The tgz is untrusted input and is unpacked by the extension
 * package rules ({@link unpackPackageTgz}: size, decompression cap, entry count, regular files only,
 * safe paths under `package/`). No code from the package runs here; the extension's module graph is
 * checked by `readExtensionPackage`.
 *
 * A tgz in the pre-0.1.0 format (a `capybara` section in package.json, or `app.yaml`, and no
 * plugin.json) is rejected first, with {@link LEGACY_FORMAT_MESSAGE}: there is no reader for the
 * old formats.
 */

/** The message for a tgz in the pre-0.1.0 format (follows the package's name). */
export const LEGACY_FORMAT_MESSAGE =
  "uses the pre-0.1.0 package format (capybara section / app.yaml); repack it as a plugin with .capybara-plugin/plugin.json (pnpm pack-plugin)";

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
export interface ReadPluginPackageOptions extends ExtensionPackageLimits {
  hostSdkVersion: string;
  hostZodVersion?: string;
}

/** `./skills/x` → `skills/x` (manifest paths start with `./`). */
export const packagePath = (p: string): string => p.replace(/^\.\//, "").replace(/\/+$/, "");

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const decode = (data: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
};

const invalid = (issues: string[]): never => {
  throw new PluginPackageError("catalog.invalid_manifest", issues);
};

/** Runs a step that reports problems as {@link ExtensionPackageError} (unpacking, package.json). */
async function step<T>(f: () => T | Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ExtensionPackageError) return invalid(e.issues);
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
    // The old formats are recognised only to say so; nothing in them is read.
    const pkg = pj && (await step(() => parsePackageJsonFile({ data: Buffer.from(pj) })));
    if (files.has("app.yaml") || (isObj(pkg) && pkg.capybara !== undefined)) {
      const who =
        isObj(pkg) && typeof pkg.name === "string" ? `Package ${pkg.name}` : "The package";
      throw new PluginPackageError("catalog.legacy_format", [`${who} ${LEGACY_FORMAT_MESSAGE}`]);
    }
    return invalid([`${PLUGIN_MANIFEST_FILE} not found in the package (the plugin manifest)`]);
  }

  const packageJson = await step(() => parsePackageJsonFile(pj && { data: Buffer.from(pj) }));

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
    let value: unknown;
    try {
      value = json === undefined ? undefined : JSON.parse(json);
    } catch {
      value = undefined;
    }
    if (value === undefined) {
      issues.push(`${path}: not valid JSON`);
      continue;
    }
    const r = parseConnectorTemplateFile(value);
    if ("errors" in r) {
      issues.push(...r.errors.map((e) => `${path}: ${e}`));
      continue;
    }
    if (r.icon !== undefined && !files.has(packagePath(r.icon))) {
      issues.push(`${path}: icon ${r.icon} not found in the package`);
    }
    connectorTemplates.push({ id, path, file: r });
  }

  if (manifest.icon !== undefined && !files.has(packagePath(manifest.icon))) {
    issues.push(`icon: ${manifest.icon} not found in the package`);
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
