// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Claude Code variables such as ${CLAUDE_PLUGIN_ROOT} are plain text here
import {
  CATALOG_ITEM_NAME_RE,
  hasShellInjection,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MANIFEST_LIMITS,
  type PluginManifest,
  parsePluginManifest,
  parseSkillMd,
  SEMVER_VERSION_RE,
  SKILL_ENTRY_FILE,
  skillInvocation,
} from "@capybara-hq/plugin-sdk";
import semver from "semver";
import { PluginPackageError } from "../plugin-package.js";
import { translateClaudeAgents } from "./agents.js";
import { CLAUDE_TRANSLATOR_REVISION, translateClaudeCommands } from "./commands.js";
import {
  asList,
  CLAUDE_PLUGIN_FILE,
  CLAUDE_STRICT_COMPONENT_KEYS,
  type ClaudeEntryOverlay,
  componentPath,
  cut,
  decodeUtf8,
  isObj,
  type JsonRead,
  readJsonFile,
  showName,
} from "./manifest.js";
import { GENERATED_CONNECTORS_DIR, mcpServerTemplates } from "./mcp.js";
import {
  item,
  printable,
  sortItems,
  type TranslationItem,
  type TranslationReport,
} from "./report.js";

/**
 * Translates a Claude Code plugin tree into a Capybara plugin tree (package ecosystem spec §8): a
 * synthesized `.capybara-plugin/plugin.json` listing every imported skill and generated connector
 * template explicitly, the templates under `.capybara-generated/connectors/`, and the allowlist
 * translation report. Pure: no I/O. The input is hostile: every problem is a report item, and only
 * the cases {@link translateClaudePlugin} names refuse the import. Skill files are never modified;
 * only a root `SKILL.md`'s files move under `skills/<name>/`.
 */

/** Options of {@link translateClaudePlugin}. */
export interface ClaudeTranslateOptions {
  /** Marketplace entry name / repo name (§8.2 "no plugin.json"). */
  fallbackName: string;
  /** Entry version, else `0.0.0-git.g<sha12>`. */
  fallbackVersion: string;
  /** Marketplace `owner.name`, else `<host>/<owner>`. */
  fallbackPublisher: string;
  /** For the "version_from_entry" item. */
  entryVersion?: string;
  overlay?: ClaudeEntryOverlay;
  /** Accept `http://` loopback MCP URLs (tests; `marketplaces.allowInsecureLoopback`). */
  allowInsecureLoopback?: boolean;
}

/** The translated plugin. */
export interface ClaudeTranslation {
  /**
   * The original files plus `.capybara-plugin/plugin.json` (synthesized) and
   * `.capybara-generated/connectors/<id>.json`; a root SKILL.md's files moved under
   * `skills/<name>/`. `package.json` is left out: in a Claude plugin it is npm metadata for other
   * harnesses, which the Capybara reader would otherwise check against the synthesized manifest.
   */
  tree: Map<string, Uint8Array>;
  report: TranslationReport;
  /** `repository` of the Claude manifest (display only, spec §8.2). */
  repository?: string;
  /**
   * {@link CLAUDE_TRANSLATOR_REVISION} when phase D changed what this tree translates to (it has a
   * command, a manual-only or a forked skill): folded into the content digest (phase D spec §8.3).
   */
  translatorRevision?: string;
}

const HOOKS_FILE = "hooks/hooks.json";
const MCP_FILE = ".mcp.json";
const MAX_HOOK_ITEMS = 100;
/**
 * Most distinct entries one component key takes over all its declarations (plugin.json and the
 * marketplace entry); the rest are counted in one "too many paths" item. Bounds the work a hostile
 * manifest can cause (each path may read and parse a file).
 */
const MAX_DECLARED_PATHS = 100;

/** Top-level `plugin.json` keys this reader knows; any other key is "unknown_field". */
const MAPPED_KEYS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "displayName",
  "author",
  "license",
  "homepage",
  "repository",
  "keywords",
  "dependencies",
  "skills",
  "commands",
  "agents",
  "hooks",
  "mcpServers",
  "types",
]);
/** Keys that mean nothing to Capybara (spec §8.3 "not applicable"). */
const NOT_APPLICABLE_KEYS = [
  "lspServers",
  "outputStyles",
  "themes",
  "monitors",
  "workflows",
  "userConfig",
  "channels",
  "settings",
  "defaultEnabled",
  "metadata",
  "icon",
  "documentationUrl",
  "supportUrl",
  "privacyPolicyUrl",
  "termsOfServiceUrl",
] as const;
/** Default files and directories that mean nothing to Capybara. */
const NOT_APPLICABLE_FILES = [
  ".lsp.json",
  "output-styles/",
  "themes/",
  "monitors/",
  "workflows/",
  "bin/",
  "settings.json",
] as const;
/** Manifests and directories of other agent harnesses at the root (besides `.<x>-plugin/`). */
const OTHER_HARNESS = [".agents/", ".opencode/", ".pi/", "gemini-extension.json"] as const;
/**
 * Root entries a root SKILL.md does not take with it (spec §8.3): every harness manifest directory
 * (`.<x>-plugin/`, including Claude's and Capybara's), `.capybara-generated/`, git files, the other
 * component directories and files, package.json and the license. The not-applicable files, the
 * other harnesses' entries and the other skill directories are excluded where the set is built.
 */
const ROOT_SKILL_EXCLUDE =
  /^(?:\.[^/]+-plugin\/|\.capybara-generated\/|\.git|hooks\/|commands\/|agents\/|skills\/|\.mcp\.json$|\.lsp\.json$|package\.json$|LICEN[CS]E)/;
/** Top directories no skill may live in: the manifests and the generated templates. */
const RESERVED_SKILL_TOPS = new Set([".capybara-plugin", ".capybara-generated", ".claude-plugin"]);
const RESTRICTION_KEYS = ["allowed-tools", "disallowed-tools", "model", "effort"] as const;
/** Claude Code's built-in sub-agent types a forked skill may name (run as general-purpose). */
const BUILTIN_AGENT_TYPES = new Set(["general-purpose", "Explore", "Plan"]);
const CLAUDE_VARIABLES = [
  "${CLAUDE_PLUGIN_ROOT}",
  "${CLAUDE_PLUGIN_DATA}",
  "${CLAUDE_PROJECT_DIR}",
  "${user_config.",
] as const;

/**
 * The tree looks like a Claude plugin: no `.capybara-plugin/plugin.json` and one of
 * `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`, `commands/`, `agents/`, a root
 * `SKILL.md`; or `hint` (a Claude marketplace entry). A tree with only `skills/` stays the A1
 * skills-only plugin.
 */
export function isClaudePluginTree(
  files: ReadonlyMap<string, Uint8Array>,
  hint?: ClaudeEntryOverlay,
): boolean {
  if (files.has(PLUGIN_MANIFEST_FILE)) return false;
  if (hint !== undefined) return true;
  if ([CLAUDE_PLUGIN_FILE, HOOKS_FILE, MCP_FILE, SKILL_ENTRY_FILE].some((p) => files.has(p))) {
    return true;
  }
  for (const p of files.keys())
    if (p.startsWith("commands/") || p.startsWith("agents/")) return true;
  return false;
}

/** One declaration of a component field: its value and where it was declared. */
interface Decl {
  value: unknown;
  /** `.claude-plugin/plugin.json` or `marketplace entry <name>`. */
  where: string;
}

const invalidManifest = (issue: string): never => {
  throw new PluginPackageError("catalog.invalid_manifest", [issue]);
};

/**
 * Translates the tree (see the file header). Throws `PluginPackageError("catalog.invalid_manifest")`
 * only for: a plugin name Capybara cannot use (including an unreadable `plugin.json`), a
 * `strict: false` conflict, a path leaving the root, and a plugin with no importable skill and no
 * template.
 */
export function translateClaudePlugin(
  files: ReadonlyMap<string, Uint8Array>,
  o: ClaudeTranslateOptions,
): ClaudeTranslation {
  const items: TranslationItem[] = [];
  const add = (...it: TranslationItem[]) => items.push(...it);
  const keys = [...files.keys()].sort();
  const under = (dir: string) => (dir === "" ? keys : keys.filter((p) => p.startsWith(`${dir}/`)));
  const dirExists = (dir: string) => keys.some((p) => p.startsWith(`${dir}/`));

  // plugin.json: optional; when present it must be a readable JSON object with a usable name.
  const manifestBytes = files.get(CLAUDE_PLUGIN_FILE);
  let m: Record<string, unknown> = {};
  if (manifestBytes !== undefined) {
    const r = readJsonFile(manifestBytes);
    if ("problem" in r) invalidManifest(`${CLAUDE_PLUGIN_FILE} is ${r.problem}`);
    else if (!isObj(r.value)) invalidManifest(`${CLAUDE_PLUGIN_FILE} must be a JSON object`);
    else m = r.value;
  }
  const hasManifest = manifestBytes !== undefined;
  const name =
    hasManifest && m.name !== undefined
      ? m.name
      : hasManifest
        ? invalidManifest(`${CLAUDE_PLUGIN_FILE}: name is required`)
        : o.fallbackName;
  if (typeof name !== "string" || !CATALOG_ITEM_NAME_RE.test(name)) {
    invalidManifest(
      `${hasManifest ? `${CLAUDE_PLUGIN_FILE} name` : "plugin name"} ${JSON.stringify(
        typeof name === "string" ? showName(name) : String(name),
      )} must match ^[a-z0-9][a-z0-9-]{0,63}$`,
    );
  }
  const pluginName = name as string;
  const field = (code: Parameters<typeof item>[0], key: string, detail?: Record<string, string>) =>
    add(item(code, "field", key, detail !== undefined ? { detail } : {}));
  const wrongType = (key: string, problem: string) => field("unknown_field", key, { problem });

  // Version (spec §5.3): plugin.json, else the entry's, else derived from the source.
  let version: string;
  if (
    typeof m.version === "string" &&
    SEMVER_VERSION_RE.test(m.version) &&
    m.version.length <= 256
  ) {
    version = m.version;
  } else if (o.entryVersion !== undefined && SEMVER_VERSION_RE.test(o.entryVersion)) {
    version = o.entryVersion;
    field("version_from_entry", "version", { version });
  } else {
    version = o.fallbackVersion;
    field("version_fallback", "version", { version });
  }

  const text = (key: string, max: number): string | undefined => {
    const v = m[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string") {
      wrongType(key, `${key} must be a string`);
      return undefined;
    }
    const s = cut(v, max);
    return s === "" ? undefined : s;
  };
  const description = text("description", PLUGIN_MANIFEST_LIMITS.descriptionChars);
  const displayName = text("displayName", PLUGIN_MANIFEST_LIMITS.displayNameChars);
  const license = text("license", 100);
  const homepageRaw = text("homepage", 2000);
  const homepage =
    homepageRaw !== undefined && /^https:\/\/\S+$/.test(homepageRaw) ? homepageRaw : undefined;
  if (homepageRaw !== undefined && homepage === undefined) {
    wrongType("homepage", "homepage must be an https URL");
  }
  const repository =
    typeof m.repository === "string" ? printable(cut(m.repository, 2000)) : undefined;

  let publisher: string | undefined;
  if (m.author !== undefined) {
    if (isObj(m.author) && typeof m.author.name === "string") {
      publisher = cut(m.author.name, PLUGIN_MANIFEST_LIMITS.publisherChars) || undefined;
    } else wrongType("author", "author must be an object with a name");
  }
  if (publisher === undefined) {
    publisher = cut(
      o.overlay?.publisher ?? o.fallbackPublisher,
      PLUGIN_MANIFEST_LIMITS.publisherChars,
    );
    field("publisher_from_marketplace", "publisher", { publisher });
  }

  // Dependencies: "name", "name@marketplace" or { name, version?, marketplace? }.
  const dependencies: { name: string; version: string }[] = [];
  if (m.dependencies !== undefined) {
    if (!Array.isArray(m.dependencies)) {
      wrongType("dependencies", "dependencies must be an array");
    } else {
      for (const d of m.dependencies) {
        let dn: unknown;
        let range: unknown;
        let marketplace: unknown;
        if (typeof d === "string") {
          const at = d.indexOf("@");
          dn = at < 0 ? d : d.slice(0, at);
          marketplace = at < 0 ? undefined : d.slice(at + 1);
        } else if (isObj(d)) {
          dn = d.name;
          range = d.version;
          marketplace = d.marketplace;
        }
        const label = typeof dn === "string" ? showName(dn) : "?";
        const ignore = (problem: string) =>
          add(item("unknown_field", "plugin", label, { detail: { problem } }));
        if (typeof dn !== "string" || !CATALOG_ITEM_NAME_RE.test(dn)) {
          ignore("the dependency name must match ^[a-z0-9][a-z0-9-]{0,63}$");
          continue;
        }
        if (dn === pluginName || dependencies.some((x) => x.name === dn)) {
          ignore("duplicate dependency or a dependency on itself");
          continue;
        }
        if (
          range !== undefined &&
          (typeof range !== "string" || semver.validRange(range) === null)
        ) {
          ignore("the dependency version must be a semver range");
          continue;
        }
        if (dependencies.length >= PLUGIN_MANIFEST_LIMITS.dependencies) {
          ignore("too many dependencies");
          continue;
        }
        const v = (range as string | undefined) ?? "*";
        dependencies.push({ name: dn, version: v });
        add(
          item("dependency_mapped", "plugin", dn, {
            detail: {
              version: v,
              ...(typeof marketplace === "string" && { marketplace: showName(marketplace) }),
            },
          }),
        );
      }
    }
  }

  // Other plugin.json keys.
  for (const k of NOT_APPLICABLE_KEYS) if (m[k] !== undefined) field("not_applicable", k);
  if (m.experimental !== undefined) {
    if (isObj(m.experimental)) {
      for (const k of Object.keys(m.experimental)) {
        field("not_applicable", `experimental.${showName(k)}`);
      }
    } else field("not_applicable", "experimental");
  }
  for (const k of Object.keys(m)) {
    if (!MAPPED_KEYS.has(k) && !(NOT_APPLICABLE_KEYS as readonly string[]).includes(k)) {
      if (k !== "experimental") field("unknown_field", showName(k));
    }
  }
  if (m.types !== undefined) add(item("hooks_module", "hook", "types"));

  // Component declarations: plugin.json, then the marketplace entry by Claude's strict rule.
  const ov = o.overlay;
  const entryWhere = `marketplace entry ${showName(o.fallbackName)}`;
  /**
   * Deduplicates and caps the entries of one component key (see MAX_DECLARED_PATHS): `take` says
   * whether to process an entry (`id` is its resolved path, or undefined for an inline object);
   * `done` reports what was left out.
   */
  const limiter = (key: string) => {
    const seen = new Set<string>();
    let taken = 0;
    let more = 0;
    return {
      take(id: string | undefined): boolean {
        if (id !== undefined && seen.has(id)) return false;
        if (taken >= MAX_DECLARED_PATHS) {
          more++;
          return false;
        }
        if (id !== undefined) seen.add(id);
        taken++;
        return true;
      },
      done() {
        if (more > 0) {
          add(item("unknown_field", "field", key, { detail: { problem: "too many paths", more } }));
        }
      },
    };
  };
  // Each JSON file is parsed at most once per translation.
  const jsonCache = new Map<string, JsonRead>();
  const readJson = (path: string, data: Uint8Array): JsonRead => {
    let r = jsonCache.get(path);
    if (r === undefined) {
      r = readJsonFile(data);
      jsonCache.set(path, r);
    }
    return r;
  };
  const decls = (key: string): Decl[] => {
    const out: Decl[] = [];
    if (m[key] !== undefined) out.push({ value: m[key], where: CLAUDE_PLUGIN_FILE });
    const ev = ov?.components[key];
    if (ev === undefined) return out;
    const strictKey = (CLAUDE_STRICT_COMPONENT_KEYS as readonly string[]).includes(key);
    if (!hasManifest || strictKey) out.push({ value: ev, where: entryWhere });
    return out;
  };
  if (ov !== undefined) {
    const entryKeys = Object.keys(ov.components);
    const entryStrict = entryKeys.filter((k) =>
      (CLAUDE_STRICT_COMPONENT_KEYS as readonly string[]).includes(k),
    );
    if (hasManifest && !ov.strict && entryStrict.length > 0) {
      const both = CLAUDE_STRICT_COMPONENT_KEYS.some((k) => m[k] !== undefined);
      if (both) {
        invalidManifest(
          `marketplace entry ${showName(o.fallbackName)} sets strict: false and declares components that plugin.json declares too`,
        );
      }
    }
    if (hasManifest) {
      for (const k of entryKeys) {
        if (!(CLAUDE_STRICT_COMPONENT_KEYS as readonly string[]).includes(k)) {
          wrongType(
            `entry.${showName(k)}`,
            "this entry field applies only to plugins without plugin.json",
          );
        }
      }
    } else {
      for (const k of NOT_APPLICABLE_KEYS) {
        if (ov.components[k] !== undefined) field("not_applicable", k);
      }
    }
    const used = entryKeys.filter((k) => !hasManifest || entryStrict.includes(k));
    if (used.length > 0) {
      field("entry_components_merged", "components", { keys: used.join(", ") });
    }
  }

  // Commands and agents: listed paths replace the default directory.
  const mdFiles = (dir: string, recursive: boolean) =>
    under(dir).filter(
      (p) => p.endsWith(".md") && (recursive || !p.slice(dir.length + 1).includes("/")),
    );
  /** The declared (else default-directory) Markdown files of `commands` / `agents`. */
  const collectMd = (key: "commands" | "agents", recursive: boolean) => {
    const ds = decls(key);
    const limit = limiter(key);
    const paths: string[] = [];
    const named: { name: string; path?: string; content?: string }[] = [];
    if (ds.length === 0) paths.push(...mdFiles(key, recursive));
    for (const d of ds) {
      if (key === "commands" && isObj(d.value)) {
        for (const [cn, cv] of Object.entries(d.value)) {
          if (!limit.take(`\0${cn}`)) continue;
          const src =
            isObj(cv) && typeof cv.source === "string"
              ? componentPath(cv.source, `${d.where} commands`)
              : null;
          const content = isObj(cv) && typeof cv.content === "string" ? cv.content : undefined;
          named.push({
            name: showName(cn),
            ...(src && "rel" in src && { path: src.rel }),
            ...(src === null && content !== undefined && { content }),
          });
        }
        continue;
      }
      const list = asList(d.value);
      if (list === null || list.some((x) => typeof x !== "string")) {
        wrongType(key, `${key} must be a path or an array of paths`);
        continue;
      }
      for (const raw of list) {
        const r = componentPath(raw, `${d.where} ${key}`);
        if (!limit.take("rel" in r ? r.rel : `\0${raw}`)) continue;
        if ("problem" in r) {
          wrongType(key, r.problem);
          continue;
        }
        if (files.has(r.rel)) paths.push(r.rel);
        else paths.push(...mdFiles(r.rel, recursive));
      }
    }
    limit.done();
    for (const p of [...new Set(paths)]) {
      const base = p.startsWith(`${key}/`)
        ? p.slice(key.length + 1)
        : (p.split("/").pop() as string);
      named.push({ name: showName(base.replace(/\.md$/, "")), path: p });
    }
    return named;
  };
  // Agents become agent templates (phase C, sub-agents spec §16.4); before the skills, whose
  // `agent` names are checked against them
  const agentPaths = collectMd("agents", true).flatMap((n) => (n.path ? [n.path] : []));
  const agents = translateClaudeAgents(files, agentPaths, pluginName);
  add(...agents.items);
  const agentNames = new Set(agents.agents.map((a) => a.name));

  /**
   * The items of an imported skill or command beyond "imported" (phase D spec §8.1): manual-only,
   * forked (with an unknown `agent` warned), shell injections, ignored restrictions.
   */
  const skillItems = (
    component: "skill" | "command",
    sn: string,
    at: { path?: string },
    fm: Readonly<Record<string, unknown>>,
    body: string,
  ): TranslationItem[] => {
    const out: TranslationItem[] = [];
    const inv = skillInvocation(fm);
    if (!inv.model) out.push(item("skill_manual_only", component, sn, at));
    if (inv.fork) {
      const agent = inv.fork.agent ?? "general-purpose";
      out.push(item("skill_forked", component, sn, { ...at, detail: { agent } }));
      const own = agent.startsWith(`${pluginName}:`) ? agent.slice(pluginName.length + 1) : agent;
      if (!BUILTIN_AGENT_TYPES.has(agent) && !agentNames.has(own)) {
        out.push(item("skill_agent_unknown", component, sn, { ...at, detail: { agent } }));
      }
    }
    if (hasShellInjection(body)) out.push(item("skill_shell_injection", component, sn, at));
    const restricted = RESTRICTION_KEYS.filter((k) => fm[k] !== undefined);
    if (restricted.length > 0) {
      out.push(
        item("skill_ignored_restrictions", component, sn, {
          ...at,
          detail: { keys: restricted.join(", ") },
        }),
      );
    }
    return out;
  };

  // Skills: skills/*/SKILL.md plus the listed directories; a root SKILL.md is one skill. A
  // directory in a reserved place, or inside / around one already taken, is an item (first wins).
  const skillDirs: string[] = [];
  const addSkillDir = (dir: string) => {
    if (skillDirs.includes(dir)) return;
    const rejected = (problem: string) =>
      add(
        item("skill_invalid", "skill", showName(dir.split("/").pop() as string), {
          path: dir,
          detail: { problem: `${showName(dir)} ${problem}` },
        }),
      );
    if (dir !== "") {
      if (RESERVED_SKILL_TOPS.has(dir.split("/")[0] as string)) {
        return rejected("is a reserved directory");
      }
      for (const d of skillDirs) {
        if (d === "") continue;
        if (dir.startsWith(`${d}/`)) return rejected(`is inside the skill directory ${d}`);
        if (d.startsWith(`${dir}/`)) return rejected(`contains the skill directory ${d}`);
      }
    }
    skillDirs.push(dir);
  };
  const skillDecls = decls("skills");
  for (const p of keys) {
    const mm = /^(skills\/[^/]+)\/SKILL\.md$/.exec(p);
    if (mm) addSkillDir(mm[1] as string);
  }
  const skillLimit = limiter("skills");
  for (const d of skillDecls) {
    const list = asList(d.value);
    if (list === null || list.some((x) => typeof x !== "string")) {
      wrongType("skills", "skills must be a path or an array of paths");
      continue;
    }
    for (const raw of list) {
      const r = componentPath(raw, `${d.where} skills`, true);
      if (!skillLimit.take("rel" in r ? r.rel : `\0${raw}`)) continue;
      if ("problem" in r) {
        wrongType("skills", r.problem);
        continue;
      }
      const dir = r.rel;
      const entry = dir === "" ? SKILL_ENTRY_FILE : `${dir}/${SKILL_ENTRY_FILE}`;
      if (files.has(entry)) {
        addSkillDir(dir);
        continue;
      }
      const re = new RegExp(`^${dir === "" ? "" : `${escapeRe(dir)}/`}([^/]+)/SKILL\\.md$`);
      const found = keys.filter((p) => re.test(p));
      if (found.length === 0) {
        add(
          item("skill_invalid", "skill", showName(dir || "."), {
            path: dir || ".",
            detail: { problem: "no SKILL.md found" },
          }),
        );
      }
      for (const p of found) addSkillDir(p.slice(0, -`/${SKILL_ENTRY_FILE}`.length));
    }
  }
  skillLimit.done();
  if (files.has(SKILL_ENTRY_FILE) && !dirExists("skills") && skillDecls.length === 0) {
    addSkillDir("");
  }

  // What a root SKILL.md leaves where it is (see ROOT_SKILL_EXCLUDE).
  const rootExcluded = (p: string) =>
    ROOT_SKILL_EXCLUDE.test(p) ||
    [...NOT_APPLICABLE_FILES, ...OTHER_HARNESS].some((f) =>
      f.endsWith("/") ? p.startsWith(f) : p === f,
    ) ||
    skillDirs.some((d) => d !== "" && p.startsWith(`${d}/`));

  const tree = new Map<string, Uint8Array>();
  for (const [p, data] of files) if (p !== "package.json") tree.set(p, data);
  const imported: { name: string; dir: string }[] = [];
  for (const dir of skillDirs) {
    const entryPath = dir === "" ? SKILL_ENTRY_FILE : `${dir}/${SKILL_ENTRY_FILE}`;
    const label = showName(dir === "" ? SKILL_ENTRY_FILE : (dir.split("/").pop() as string));
    const at = { path: dir === "" ? SKILL_ENTRY_FILE : dir };
    const md = decodeUtf8(files.get(entryPath) as Uint8Array);
    const parsed = md === undefined ? { errors: ["not valid UTF-8 text"] } : parseSkillMd(md);
    if ("errors" in parsed) {
      add(
        item("skill_invalid", "skill", label, {
          ...at,
          detail: { problem: parsed.errors.join("; ") },
        }),
      );
      continue;
    }
    const fm = parsed.frontmatter;
    const sn = parsed.name;
    const other = imported.find((s) => s.name === sn);
    if (other !== undefined) {
      add(
        item("skill_invalid", "skill", sn, {
          ...at,
          detail: { problem: `skill name ${sn} is also used by ${other.dir || SKILL_ENTRY_FILE}` },
        }),
      );
      continue;
    }
    if (imported.length >= PLUGIN_MANIFEST_LIMITS.skills) {
      add(item("skill_invalid", "skill", sn, { ...at, detail: { problem: "too many skills" } }));
      continue;
    }
    let target = dir;
    const skillFiles = dir === "" ? keys.filter((p) => !rootExcluded(p)) : under(dir);
    if (dir === "") {
      target = `skills/${sn}`;
      if (dirExists(target)) {
        add(
          item("skill_invalid", "skill", sn, {
            ...at,
            detail: { problem: `the root SKILL.md cannot move to ${target}: it exists` },
          }),
        );
        continue;
      }
      for (const p of skillFiles) {
        tree.delete(p);
        tree.set(`${target}/${p}`, files.get(p) as Uint8Array);
      }
      add(
        item("skill_root_relocated", "skill", sn, {
          path: SKILL_ENTRY_FILE,
          detail: { to: target },
        }),
      );
    }
    imported.push({ name: sn, dir: target });
    add(item("skill_imported", "skill", sn, { path: target }));
    add(...skillItems("skill", sn, { path: target }, fm, parsed.body));
    const seen = new Set<string>();
    for (const p of skillFiles) {
      const t = decodeUtf8(files.get(p) as Uint8Array);
      if (t === undefined) continue;
      for (const v of CLAUDE_VARIABLES) if (t.includes(v)) seen.add(v);
    }
    if (seen.size > 0) {
      const variables = CLAUDE_VARIABLES.filter((v) => seen.has(v))
        .map((v) => (v.endsWith(".") ? `${v}*}` : v))
        .join(", ");
      add(item("skill_claude_variables", "skill", sn, { path: target, detail: { variables } }));
    }
  }

  // Commands become skills (phase D spec §8.2), after the skills: a skill wins over a command
  const commands = translateClaudeCommands(
    files,
    collectMd("commands", false),
    new Set(imported.map((x) => x.name)),
    { room: PLUGIN_MANIFEST_LIMITS.skills - imported.length, skillItems },
  );
  add(...commands.items);
  for (const [p, data] of commands.generated) tree.set(p, data);
  imported.push(...commands.skills);

  // Hooks: never run (spec §8.3); one item per event with its handler types.
  const events = new Map<string, { types: Set<string>; path?: string }>();
  const hookProblems: TranslationItem[] = [];
  const readEvents = (map: unknown, path: string | undefined) => {
    if (!isObj(map)) {
      hookProblems.push(
        item("hooks_not_run", "hook", showName(path ?? "hooks"), {
          ...(path !== undefined && { path }),
          detail: { problem: "the hooks configuration is not an object" },
        }),
      );
      return;
    }
    for (const [ev, matchers] of Object.entries(map)) {
      const e = events.get(ev) ?? { types: new Set<string>(), ...(path !== undefined && { path }) };
      events.set(ev, e);
      if (!Array.isArray(matchers)) continue;
      for (const mt of matchers.slice(0, 1000)) {
        if (!isObj(mt) || !Array.isArray(mt.hooks)) continue;
        for (const h of mt.hooks.slice(0, 1000)) {
          if (isObj(h) && typeof h.type === "string") e.types.add(showName(h.type));
        }
      }
    }
  };
  const readHooksFile = (path: string) => {
    const data = files.get(path);
    if (data === undefined) {
      hookProblems.push(
        item("hooks_not_run", "hook", showName(path), {
          path,
          detail: { problem: "file not found" },
        }),
      );
      return;
    }
    const r = readJson(path, data);
    if ("problem" in r) {
      hookProblems.push(
        item("hooks_not_run", "hook", showName(path), { path, detail: { problem: r.problem } }),
      );
      return;
    }
    readEvents(isObj(r.value) ? r.value.hooks : undefined, path);
  };
  if (files.has(HOOKS_FILE)) readHooksFile(HOOKS_FILE);
  const hookLimit = limiter("hooks");
  for (const d of decls("hooks")) {
    const list = Array.isArray(d.value) ? d.value : [d.value];
    for (const h of list) {
      if (isObj(h)) {
        if (!hookLimit.take(undefined)) continue;
        readEvents(h, d.where === CLAUDE_PLUGIN_FILE ? CLAUDE_PLUGIN_FILE : undefined);
        continue;
      }
      const r = componentPath(h, `${d.where} hooks`);
      if (!hookLimit.take("rel" in r ? r.rel : `\0${String(h)}`)) continue;
      if ("problem" in r) {
        wrongType("hooks", r.problem);
        continue;
      }
      if (/\.(?:[cm]?js|[cm]?ts)$/.test(r.rel)) {
        add(item("hooks_module", "hook", showName(r.rel), { path: r.rel }));
        continue;
      }
      readHooksFile(r.rel);
    }
  }
  hookLimit.done();
  const eventItems = [...events.entries()].map(([ev, e]) =>
    item("hooks_not_run", "hook", showName(ev), {
      ...(e.path !== undefined && { path: e.path }),
      detail: { handlers: [...e.types].sort().join(", ") },
    }),
  );
  add(...eventItems.slice(0, MAX_HOOK_ITEMS), ...hookProblems.slice(0, MAX_HOOK_ITEMS));
  const moreHooks =
    Math.max(0, eventItems.length - MAX_HOOK_ITEMS) +
    Math.max(0, hookProblems.length - MAX_HOOK_ITEMS);
  if (moreHooks > 0) add(item("hooks_not_run", "hook", "…", { detail: { more: moreHooks } }));
  const sessionStart = events.has("SessionStart");
  if (sessionStart) add(item("session_start_pin_hint", "hook", "SessionStart"));

  // MCP servers: .mcp.json first, then each declaration; a later name replaces an earlier one.
  // A Map: an untrusted "__proto__" key must never touch an object's prototype.
  const servers = new Map<string, unknown>();
  const serverPaths = new Map<string, string>();
  const takeServers = (map: unknown, path: string | undefined) => {
    if (!isObj(map)) {
      add(
        item("mcp_invalid", "mcpServer", showName(path ?? "mcpServers"), {
          ...(path !== undefined && { path }),
          detail: { reason: "not an object" },
        }),
      );
      return;
    }
    const inner = isObj(map.mcpServers) ? map.mcpServers : map;
    for (const [k, v] of Object.entries(inner)) {
      if (k === "__proto__") {
        add(
          item("mcp_invalid", "mcpServer", k, {
            ...(path !== undefined && { path }),
            detail: { reason: "the server name __proto__ is not allowed" },
          }),
        );
        continue;
      }
      if (servers.size >= 200 && !servers.has(k)) {
        add(
          item("mcp_invalid", "mcpServer", showName(k), {
            ...(path !== undefined && { path }),
            detail: { reason: "too many servers" },
          }),
        );
        continue;
      }
      servers.set(k, v);
      if (path !== undefined) serverPaths.set(k, path);
      else serverPaths.delete(k);
    }
  };
  const readMcpFile = (path: string) => {
    const data = files.get(path);
    const r = data === undefined ? { problem: "file not found" } : readJson(path, data);
    if ("problem" in r) {
      add(
        item("mcp_invalid", "mcpServer", showName(path), { path, detail: { reason: r.problem } }),
      );
      return;
    }
    takeServers(r.value, path);
  };
  if (files.has(MCP_FILE)) readMcpFile(MCP_FILE);
  const mcpLimit = limiter("mcpServers");
  for (const d of decls("mcpServers")) {
    const list = Array.isArray(d.value) ? d.value : [d.value];
    for (const s of list) {
      if (!mcpLimit.take(isObj(s) ? undefined : `\0${String(s)}`)) continue;
      if (isObj(s)) {
        takeServers(s, d.where === CLAUDE_PLUGIN_FILE ? CLAUDE_PLUGIN_FILE : undefined);
        continue;
      }
      if (typeof s === "string" && /^https:\/\//.test(s) && /\.(?:mcpb|dxt)$/.test(s)) {
        add(
          item("mcp_unsupported_transport", "mcpServer", showName(s), {
            detail: { transport: "mcpb" },
          }),
        );
        continue;
      }
      const r = componentPath(s, `${d.where} mcpServers`);
      if ("problem" in r) {
        wrongType("mcpServers", r.problem);
        continue;
      }
      if (/\.(?:mcpb|dxt)$/.test(r.rel)) {
        add(
          item("mcp_unsupported_transport", "mcpServer", showName(r.rel), {
            path: r.rel,
            detail: { transport: r.rel.endsWith(".dxt") ? "dxt" : "mcpb" },
          }),
        );
        continue;
      }
      readMcpFile(r.rel);
    }
  }
  mcpLimit.done();
  const mcp = mcpServerTemplates(servers, pluginName, {
    paths: serverPaths,
    ...(o.allowInsecureLoopback === true && { allowInsecureLoopback: true }),
  });
  add(...mcp.items);

  // Not applicable files and other harnesses' manifests.
  for (const f of NOT_APPLICABLE_FILES) {
    const present = f.endsWith("/") ? dirExists(f.slice(0, -1)) : files.has(f);
    if (present)
      add(item("not_applicable", "file", f.replace(/\/$/, ""), { path: f.replace(/\/$/, "") }));
  }
  const harness = new Set<string>();
  for (const p of keys) {
    const top = p.split("/")[0] as string;
    if (
      p.includes("/") &&
      /^\.[^/]+-plugin$/.test(top) &&
      top !== ".claude-plugin" &&
      top !== ".capybara-plugin"
    ) {
      harness.add(top);
    }
  }
  for (const f of OTHER_HARNESS) {
    if (f.endsWith("/") ? dirExists(f.slice(0, -1)) : files.has(f))
      harness.add(f.replace(/\/$/, ""));
  }
  for (const h of harness) add(item("other_harness", "file", h, { path: h }));

  if (imported.length === 0 && mcp.files.size === 0 && agents.agents.length === 0) {
    invalidManifest(
      "the Claude Code plugin has no skill Capybara can import, no agent and no remote MCP server (see the translation report)",
    );
  }

  // The synthesized manifest lists every skill and template, so the reader never scans.
  const templatePaths: string[] = [];
  for (const [id, file] of mcp.files) {
    const p = `${GENERATED_CONNECTORS_DIR}/${id}.json`;
    tree.set(p, new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`));
    templatePaths.push(p);
  }
  for (const a of agents.agents) tree.set(a.path, a.data);
  const manifest: PluginManifest = {
    schemaVersion: 1,
    name: pluginName,
    version,
    publisher: publisher || pluginName,
    description: description ?? `Claude Code plugin ${pluginName}`,
    ...(displayName !== undefined && { displayName: { zh: displayName, en: displayName } }),
    ...(license !== undefined && { license }),
    ...(homepage !== undefined && { homepage }),
    ...(dependencies.length > 0 && { dependencies }),
    skills: imported.map((s) => ({ path: `./${s.dir}` })),
    connectorTemplates: templatePaths.map((p) => ({ path: `./${p}` })),
    // always listed, empty when nothing translated: without the list readPluginFiles would scan
    // the raw Claude agents/*.md the tree still holds and parse them as Capybara templates
    // (batch 12 review I1); normalizedManifest drops an empty list, so digests are unchanged
    agents: agents.agents.map((a) => ({ path: `./${a.path}` })),
  };
  const checked = parsePluginManifest(manifest);
  if ("errors" in checked) {
    invalidManifest(`${PLUGIN_MANIFEST_FILE} (translated): ${checked.errors[0]}`);
  }
  tree.set(
    PLUGIN_MANIFEST_FILE,
    new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  );

  return {
    tree,
    report: {
      format: "claude-code",
      manifestPath: hasManifest ? CLAUDE_PLUGIN_FILE : null,
      sessionStart,
      items: sortItems(items),
    },
    ...(repository !== undefined && repository !== "" && { repository }),
    ...(items.some(
      (i) =>
        i.component === "command" || i.code === "skill_manual_only" || i.code === "skill_forked",
    ) && { translatorRevision: CLAUDE_TRANSLATOR_REVISION }),
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
