import { createHash } from "node:crypto";
import {
  AGENT_TEMPLATE_LIMITS,
  type AgentTemplate,
  CATALOG_ITEM_NAME_RE,
  CONNECTOR_TEMPLATE_LIMITS,
  type ConnectorTemplateFile,
  hostSdkProblem,
  type ParsedTheme,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MANIFEST_LIMITS,
  type PluginManifest,
  parseAgentTemplate,
  parseConnectorTemplateFile,
  parsePluginManifest,
  parseSkillMd,
  parseThemeFile,
  SKILL_ENTRY_FILE,
  setupGuideDocPath,
  setupGuideDocProblem,
  THEME_LIMITS,
  themeIdOf,
  validatePluginPackageJsonFor,
  validateSetupGuide,
  validateThemeAssets,
} from "@capybara-hq/plugin-sdk";
import { ApiError } from "../errors.js";
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
 * checked by `readExtensionPackage`. The checks after unpacking live in {@link readPluginFiles},
 * shared with the git reader (`git-source.ts`), which reads the tree from a commit instead.
 *
 * A tgz in the pre-0.1.0 format (a `capybara` section in package.json, or `app.yaml`, and no
 * plugin.json) is rejected first, with {@link LEGACY_FORMAT_MESSAGE}: there is no reader for the
 * old formats.
 */

/**
 * Codes of {@link PluginPackageError}: `theme.invalid` / `theme.unreadable` when the package's only
 * problems are in its themes (themes spec §5: a failing theme refuses the whole plugin).
 */
export type PluginPackageErrorCode =
  | "catalog.invalid_manifest"
  | "catalog.legacy_format"
  | "theme.invalid"
  | "theme.unreadable";

/** The problems of one theme of a refused plugin (English; `unreadable:` lines for readability). */
export interface PluginThemeProblem {
  /** The theme id (the file's base name). */
  theme: string;
  problems: string[];
}

/** The plugin package is invalid; `issues` lists the problems (English, shown to the admin). */
export class PluginPackageError extends Error {
  readonly code: PluginPackageErrorCode;
  readonly issues: string[];
  /** The failing themes of a `theme.*` code. */
  readonly themes?: PluginThemeProblem[];
  constructor(code: PluginPackageErrorCode, issues: string[], themes?: PluginThemeProblem[]) {
    super(
      code === "catalog.legacy_format"
        ? (issues[0] ?? LEGACY_FORMAT_MESSAGE)
        : code === "theme.invalid" || code === "theme.unreadable"
          ? `Theme ${themes?.[0]?.theme ?? "?"} ${code === "theme.invalid" ? "is invalid" : "is not readable"}: ${issues[0] ?? "unknown problem"}`
          : `Invalid plugin package: ${issues[0] ?? "unknown problem"}`,
    );
    this.name = "PluginPackageError";
    this.code = code;
    this.issues = issues;
    if (themes !== undefined) this.themes = themes;
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

/** An agent template of the plugin (sub-agents spec §16.1). */
export interface PluginPackageAgentTemplate {
  /** The template name (frontmatter `name`); the roster type is `<plugin>:<name>`. */
  name: string;
  /** Relative to the package root (no leading `./`). */
  path: string;
  template: AgentTemplate;
}

/** A theme of the plugin (themes spec §4); `id` is the file's base name. */
export interface PluginPackageTheme {
  id: string;
  /** Relative to the package root (no leading `./`). */
  path: string;
  theme: ParsedTheme;
  /**
   * The theme's fonts and logo files after `validateThemeAssets` (the SVGs sanitized, the rest
   * unchanged), keyed by their path relative to the package root (no leading `./`).
   */
  assets: Map<string, Uint8Array>;
}

/** A validated plugin file tree. Paths are relative to the plugin root (no `package/`). */
export interface PluginContents {
  /** `{}` when a git plugin has no package.json. */
  packageJson: Record<string, unknown>;
  manifest: PluginManifest;
  files: Map<string, Uint8Array>;
  skills: PluginPackageSkill[];
  connectorTemplates: PluginPackageConnectorTemplate[];
  /** Agent templates (listed in plugin.json `agents`, else scanned from `agents/*.md`). */
  agentTemplates: PluginPackageAgentTemplate[];
  /** Themes (listed in plugin.json `themes`, else scanned from `themes/*.json`). */
  themes: PluginPackageTheme[];
  /** {@link contentDigest} of `files` (the same for a tgz and a git tree of the same files). */
  contentDigest: string;
}

/** A read and validated plugin tgz. */
export interface PluginPackage extends PluginContents {
  /** Hex sha256 of the whole tgz. */
  sha256: string;
  /** tgz bytes. */
  size: number;
}

/** Options of {@link readPluginPackage}; `hostZodVersion` defaults to the kernel's zod. */
export interface ReadPluginPackageOptions extends PackageTgzLimits {
  hostSdkVersion: string;
  hostZodVersion?: string;
  /**
   * A marketplace archive: a tgz without `plugin.json` whose root has `skills/` is a skills-only
   * plugin with this name and publisher (package.json optional, like git), versioned by `version`
   * (the entry's) or else {@link archiveFallbackVersion} (spec §5.3).
   */
  fallback?: { name: string; version?: string; publisher: string };
}

/**
 * The content digest of a plugin's files (Decision 5): sha256 (hex) over the file list sorted by
 * path (code unit order), each entry `path + "\0" + sha256(content) + "\n"`. Paths are relative to
 * the plugin root, so a tgz and a git tree of the same files have the same digest. Paths are hashed
 * byte for byte as they were read: no Unicode normalization (an NFC and an NFD spelling of the same
 * name are different files, as they are to git and tar). Both readers refuse control characters in
 * paths, so `\0` and `\n` cannot occur inside a path and the list is unambiguous; a path with one
 * is refused here too.
 */
export function contentDigest(files: ReadonlyMap<string, Uint8Array>): string {
  const h = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
    if (/[\u0000-\u001f\u007f]/.test(path)) {
      throw new Error(`unsafe path ${JSON.stringify(path)} in a content digest`);
    }
    const data = files.get(path) as Uint8Array;
    h.update(`${path}\0${createHash("sha256").update(data).digest("hex")}\n`);
  }
  return h.digest("hex");
}

/**
 * The version of an archive plugin that has none (spec §5.3): `0.0.0-sha256.h<12>` from the content
 * digest. The `h` keeps the prerelease identifier alphanumeric (twelve hex digits with a leading
 * zero are not valid semver).
 */
export const archiveFallbackVersion = (digest: string): string =>
  `0.0.0-sha256.h${digest.slice(0, 12)}`;

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

/** {@link step} for synchronous steps. */
function stepSync<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof PackageTgzError) return invalid(e.issues);
    throw e;
  }
}

/**
 * Without package.json only the host SDK check of `validatePluginPackageJsonFor` applies (the
 * peerDependencies rules are about package.json itself).
 */
function hostSdkIssues(manifest: PluginManifest, hostSdkVersion: string): string[] {
  const sdk = manifest.extension?.manifest.sdk;
  const problem = sdk === undefined ? undefined : hostSdkProblem(sdk, hostSdkVersion);
  return problem === undefined ? [] : [problem];
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
  const fb = opts.fallback !== undefined && !files.has(PLUGIN_MANIFEST_FILE) ? opts.fallback : null;
  const contents = readPluginFiles(files, {
    hostSdkVersion: opts.hostSdkVersion,
    ...(opts.hostZodVersion !== undefined && { hostZodVersion: opts.hostZodVersion }),
    requirePackageJson: fb === null,
    ...(fb !== null && {
      fallbackName: fb.name,
      fallbackVersion: fb.version ?? archiveFallbackVersion(contentDigest(files)),
      fallbackPublisher: fb.publisher,
    }),
  });
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    ...contents,
  };
}

/** Options of {@link readPluginFiles}. */
export interface ReadPluginFilesOptions {
  hostSdkVersion: string;
  /** Defaults to the kernel's zod. */
  hostZodVersion?: string;
  /**
   * tgz: true (`package.json` must be there and match the manifest). Git: false (spec §4.1: it is
   * needed only for npm); when it is absent nothing of it is checked.
   */
  requirePackageJson: boolean;
  /**
   * Without `plugin.json` and `requirePackageJson: false`, a tree with `skills/` is a skills-only
   * plugin with this name and version (Decision 3: the marketplace entry name, or the last segment
   * of the repo URL; the version per spec §5.3). Ignored when `plugin.json` exists.
   */
  fallbackName?: string;
  fallbackVersion?: string;
  /**
   * The publisher of that skills-only plugin: the marketplace manifest's `owner.name`, else the
   * repo owner (`<host>/<owner>`).
   */
  fallbackPublisher?: string;
  /**
   * false: skip the SKILL.md invocation key checks (a translated Claude Code plugin, whose source
   * SKILL.md files are kept as written; the translator reported the keys it ignores). Default true.
   */
  invocationKeys?: boolean;
}

/** Synthesized `plugin.json` of a skills-only tree without one (Decision 3). */
function fallbackManifest(
  files: Map<string, Uint8Array>,
  opts: ReadPluginFilesOptions,
): PluginManifest | undefined {
  if (opts.requirePackageJson || opts.fallbackName === undefined) return undefined;
  if (opts.fallbackVersion === undefined) return undefined;
  if (![...files.keys()].some((p) => p.startsWith("skills/"))) return undefined;
  const parsed = parsePluginManifest({
    schemaVersion: 1,
    name: opts.fallbackName,
    version: opts.fallbackVersion,
    publisher: opts.fallbackPublisher ?? opts.fallbackName,
    description: `Skills of ${opts.fallbackName} (no ${PLUGIN_MANIFEST_FILE})`,
  });
  if ("errors" in parsed) {
    return invalid(parsed.errors.map((e) => `${PLUGIN_MANIFEST_FILE} (derived): ${e}`));
  }
  return parsed;
}

/**
 * Validates a plugin's file tree (paths relative to the plugin root, `/`-separated, already safe):
 * the tgz reader after unpacking and the git reader share every check here. Throws
 * {@link PluginPackageError} like {@link readPluginPackage}.
 */
export function readPluginFiles(
  files: Map<string, Uint8Array>,
  opts: ReadPluginFilesOptions,
): PluginContents {
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
  }
  const fallback = manifestBytes === undefined ? fallbackManifest(files, opts) : undefined;
  if (manifestBytes === undefined && fallback === undefined) {
    if (pj) stepSync(() => parsePackageJsonFile({ data: pj }));
    return invalid([`${PLUGIN_MANIFEST_FILE} not found in the package (the plugin manifest)`]);
  }

  const packageJson =
    pj === undefined && !opts.requirePackageJson
      ? undefined
      : stepSync(() => parsePackageJsonFile(pj && { data: pj }));

  let manifest: PluginManifest;
  if (manifestBytes === undefined) manifest = fallback as PluginManifest;
  else {
    const text = decode(manifestBytes);
    if (text === undefined) return invalid([`${PLUGIN_MANIFEST_FILE} is not valid UTF-8 text`]);
    const parsed = parsePluginManifest(text);
    if ("errors" in parsed) {
      return invalid(parsed.errors.map((e) => `${PLUGIN_MANIFEST_FILE}: ${e}`));
    }
    manifest = parsed;
  }

  const issues =
    packageJson !== undefined
      ? validatePluginPackageJsonFor(packageJson, manifest, opts.hostSdkVersion, {
          hostZodVersion: opts.hostZodVersion ?? HOST_ZOD_VERSION,
        })
      : hostSdkIssues(manifest, opts.hostSdkVersion);
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
    const r = parseSkillMd(md, { invocationKeys: opts.invocationKeys !== false });
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

  // Agent templates: listed, or scanned from agents/*.md.
  const agentPaths: string[] = [];
  if (manifest.agents !== undefined) {
    manifest.agents.forEach((a, i) => {
      const path = packagePath(a.path);
      if (!files.has(path)) issues.push(`agents.${i}: ${a.path} not found in the package`);
      else agentPaths.push(path);
    });
  } else {
    for (const p of [...files.keys()].sort()) {
      if (/^agents\/[^/]+\.md$/.test(p)) agentPaths.push(p);
    }
    if (agentPaths.length > AGENT_TEMPLATE_LIMITS.perPlugin) {
      issues.push(
        `agents/ holds ${agentPaths.length} agent templates; a plugin may have at most ${AGENT_TEMPLATE_LIMITS.perPlugin}`,
      );
    }
  }
  const agentTemplates: PluginPackageAgentTemplate[] = [];
  const agentNames = new Map<string, string>();
  for (const path of agentPaths) {
    const md = decode(files.get(path) as Uint8Array);
    if (md === undefined) {
      issues.push(`${path}: not valid UTF-8 text`);
      continue;
    }
    const r = parseAgentTemplate(md);
    if ("errors" in r) {
      issues.push(...r.errors.map((e) => `${path}: ${e}`));
      continue;
    }
    const other = agentNames.get(r.template.name);
    if (other !== undefined) {
      issues.push(`${path}: agent template name "${r.template.name}" is also used by ${other}`);
      continue;
    }
    agentNames.set(r.template.name, path);
    agentTemplates.push({ name: r.template.name, path, template: r.template });
  }

  const { themes, themePaths, themeProblems } = readThemes(files, manifest);

  if (manifest.icon !== undefined) {
    const icon = files.get(packagePath(manifest.icon));
    const problem =
      icon === undefined
        ? `${manifest.icon} not found in the package`
        : iconProblem(manifest.icon, icon);
    if (problem !== undefined) issues.push(`icon: ${problem}`);
  }

  const ext = manifest.extension;
  // Setup guides v2 (spec 2026-11-09-setup-guides-v2-design.md §4.5): the documents are text
  // within the limits and pass the SDK validator (an unknown variable is accepted: it renders as
  // written); a channel guide needs a channel extension, which the manifest parser checks when the
  // extension section is there; a template guide names one of the plugin's connector templates
  const templateIds = new Set(connectorTemplates.map((t) => t.id));
  manifest.setupGuides?.forEach((g, i) => {
    const at = `setupGuides.${i} (${g.id})`;
    if (g.place === "channel-connection" && ext === undefined) {
      issues.push(
        `${at}: a channel-connection guide needs the plugin's extension to provide channel@1`,
      );
    }
    // a listed template is checked by the manifest parser; scanned ones only here
    if (
      g.template !== undefined &&
      manifest.connectorTemplates === undefined &&
      !templateIds.has(g.template)
    ) {
      issues.push(`${at}: template ${g.template} is not one of the plugin's connector templates`);
    }
    const docs: Partial<Record<"en" | "zh", string>> = {};
    for (const locale of ["en", "zh"] as const) {
      const path = setupGuideDocPath(g.id, locale);
      const data = files.get(path);
      if (locale === "zh" && data === undefined) continue;
      const problem = setupGuideDocProblem(path, data);
      if (problem !== undefined) issues.push(`${at}: ${problem}`);
      else docs[locale] = new TextDecoder().decode(data);
    }
    if (docs.en === undefined) return;
    for (const issue of validateSetupGuide({
      place: g.place,
      en: docs.en,
      ...(docs.zh !== undefined && { zh: docs.zh }),
      id: g.id,
      allowUnknownVariables: true,
    })) {
      if (issue.level === "error") issues.push(`${at}: ${issue.message}`);
    }
  });

  if (ext !== undefined) {
    if (!files.has(packagePath(ext.entry))) {
      issues.push(
        `extension.entry: ${ext.entry} not found in the package (the plugin has an extension but no build output; build it before packing or committing it)`,
      );
    }
    for (const k of ["migrations", "ui"] as const) {
      const dir = ext[k];
      if (dir !== undefined && under(packagePath(dir)).length === 0) {
        issues.push(`extension.${k}: directory ${dir} is missing or empty`);
      }
    }
  } else if (
    skillDirs.length === 0 &&
    templatePaths.length === 0 &&
    agentPaths.length === 0 &&
    themePaths.length === 0
  ) {
    issues.push(
      "a plugin must contain an extension, a skill, a connector template, an agent template or a theme",
    );
  }

  if (issues.length > 0) {
    // Other problems first: the theme problems are listed with them as plain issues
    invalid([
      ...issues,
      ...themeProblems.flatMap((t) => t.problems.map((p) => `themes/${t.theme}: ${p}`)),
    ]);
  }
  if (themeProblems.length > 0) throw pluginThemeError(themeProblems);
  return {
    packageJson: (packageJson ?? {}) as Record<string, unknown>,
    manifest,
    files,
    skills,
    connectorTemplates,
    agentTemplates,
    themes,
    contentDigest: contentDigest(files),
  };
}

const UNREADABLE = "unreadable:";

/**
 * The refusal of a plugin whose only problems are in its themes: `theme.invalid` when any theme
 * has a problem other than readability (those themes listed), else `theme.unreadable` (every
 * failing theme listed with its failing pairs).
 */
export function pluginThemeError(problems: PluginThemeProblem[]): PluginPackageError {
  const invalidOnes = problems.filter((t) => t.problems.some((p) => !p.startsWith(UNREADABLE)));
  const code = invalidOnes.length > 0 ? "theme.invalid" : "theme.unreadable";
  const listed = invalidOnes.length > 0 ? invalidOnes : problems;
  return new PluginPackageError(
    code,
    listed.flatMap((t) => t.problems),
    listed,
  );
}

/**
 * The API error of a `theme.*` {@link PluginPackageError}: 400 `theme.invalid` with details
 * `[{ theme, errors }]`, or 400 `theme.unreadable` with details `[{ theme, issues }]`.
 */
export function themeApiError(e: PluginPackageError): ApiError {
  const code = e.code === "theme.unreadable" ? "theme.unreadable" : "theme.invalid";
  const key = code === "theme.invalid" ? "errors" : "issues";
  return new ApiError(
    code,
    e.message,
    (e.themes ?? []).map((t) => ({ theme: t.theme, [key]: t.problems })),
  );
}

/**
 * The plugin's themes (themes spec §4-§5): listed in `manifest.themes`, else scanned from
 * `themes/*.json` (at most {@link THEME_LIMITS}`.perPlugin`); each parsed by `parseThemeFile`
 * (shape, token grammar, readability) and its assets checked by `validateThemeAssets`. The asset
 * limit is per plugin, so the sizes of the distinct asset paths are also summed over all themes.
 * Problems are returned per theme, never thrown.
 */
function readThemes(
  files: Map<string, Uint8Array>,
  manifest: PluginManifest,
): { themes: PluginPackageTheme[]; themePaths: string[]; themeProblems: PluginThemeProblem[] } {
  const themeProblems: PluginThemeProblem[] = [];
  const problem = (theme: string, problems: string[]) => {
    const t = themeProblems.find((x) => x.theme === theme);
    if (t) t.problems.push(...problems);
    else themeProblems.push({ theme, problems: [...problems] });
  };
  const themePaths: string[] = [];
  if (manifest.themes !== undefined) {
    for (const t of manifest.themes) {
      const path = packagePath(t.path);
      if (!files.has(path)) problem(themeIdOf(path), [`${t.path} not found in the package`]);
      else if (!themePaths.includes(path)) themePaths.push(path);
    }
  } else {
    for (const p of [...files.keys()].sort()) {
      if (/^themes\/[^/]+\.json$/.test(p)) themePaths.push(p);
    }
    if (themePaths.length > THEME_LIMITS.perPlugin) {
      problem(themeIdOf(themePaths[THEME_LIMITS.perPlugin] as string), [
        `themes/ holds ${themePaths.length} themes; a plugin may have at most ${THEME_LIMITS.perPlugin}`,
      ]);
    }
  }
  const themes: PluginPackageTheme[] = [];
  const sizes = new Map<string, number>();
  for (const path of themePaths) {
    const id = themeIdOf(path);
    if (themes.some((t) => t.id === id)) {
      problem(id, [`${path}: another theme of the plugin has the id "${id}"`]);
      continue;
    }
    const bytes = files.get(path) as Uint8Array;
    if (bytes.byteLength > THEME_LIMITS.fileBytes) {
      problem(id, [`${path}: the theme file is larger than ${THEME_LIMITS.fileBytes} bytes`]);
      continue;
    }
    const json = decode(bytes);
    if (json === undefined) {
      problem(id, [`${path}: not valid UTF-8 text`]);
      continue;
    }
    const parsed = parseThemeFile(id, json);
    if ("errors" in parsed) {
      problem(id, parsed.errors);
      continue;
    }
    const { assets, errors } = validateThemeAssets(parsed, files);
    if (errors.length > 0) {
      problem(id, errors);
      continue;
    }
    let total = 0;
    for (const p of assets.keys()) sizes.set(p, (files.get(p) as Uint8Array).byteLength);
    for (const n of sizes.values()) total += n;
    if (total > THEME_LIMITS.assetsBytes) {
      problem(id, [
        `the plugin's theme assets are larger than ${THEME_LIMITS.assetsBytes} bytes in total (${total}); the limit covers all of the plugin's themes`,
      ]);
      continue;
    }
    themes.push({ id, path, theme: parsed, assets });
  }
  return { themes, themePaths, themeProblems };
}
