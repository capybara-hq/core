import { isSkillName, parseSkillMd, SKILL_ENTRY_FILE, SKILL_LIMITS } from "@capybara-hq/plugin-sdk";
import { parse as parseYaml } from "yaml";
import { cut, decodeUtf8, isObj, showName } from "./manifest.js";
import { item, type TranslationItem } from "./report.js";

/**
 * Claude Code commands (`commands/*.md`, listed paths, or the `commands` object map with `source`
 * or inline `content`) become ordinary skills (phase D spec §8.2, decided 2026-10-27: the model can
 * invoke them too, as in Claude Code; only `disable-model-invocation: true` makes one manual-only).
 * Each command's generated SKILL.md lives at `.capybara-generated/commands/<name>/SKILL.md`; the
 * source file is never rewritten. Pure: no I/O.
 */

/** Where the generated SKILL.md of each command lives. */
export const GENERATED_COMMANDS_DIR = ".capybara-generated/commands";

/** Folded into the content digest of a plugin whose translation phase D changed (§8.3). */
export const CLAUDE_TRANSLATOR_REVISION = "claude-translation-2";

/** Frontmatter keys of a command copied into its generated SKILL.md. */
const COPIED_KEYS = [
  "disable-model-invocation",
  "user-invocable",
  "argument-hint",
  "arguments",
  "context",
  "agent",
] as const;

const FRONTMATTER_MAX_CHARS = 64 * 1024;

/** A command's frontmatter mapping and body, or a problem (English, for the report). */
function readCommand(
  text: string,
): { fm: Record<string, unknown>; body: string } | { problem: string } {
  const src = (text.startsWith("﻿") ? text.slice(1) : text).replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  // A command needs no frontmatter: the whole file is then its body
  if (lines[0]?.trimEnd() !== "---") return { fm: {}, body: src };
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end < 0) return { problem: "the frontmatter is not closed by a '---' line" };
  const front = lines.slice(1, end).join("\n");
  if (front.length > FRONTMATTER_MAX_CHARS) return { problem: "the frontmatter is too long" };
  let data: unknown;
  try {
    data = parseYaml(front, { uniqueKeys: true, maxAliasCount: 50 });
  } catch (e) {
    return { problem: `the frontmatter is not valid YAML: ${String(e).split("\n")[0]}` };
  }
  if (data === null || data === undefined) data = {};
  if (!isObj(data)) return { problem: "the frontmatter is not a YAML mapping" };
  return { fm: data, body: lines.slice(end + 1).join("\n") };
}

/** The first non-empty body line, flattened to one line and cut to the skill description limit. */
const firstLine = (body: string): string => {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  return cut(line.replace(/\s+/g, " "), SKILL_LIMITS.descriptionMaxChars);
};

/** The result of {@link translateClaudeCommands}. */
export interface TranslatedCommands {
  /** Generated files: `.capybara-generated/commands/<name>/SKILL.md`. */
  generated: Map<string, Uint8Array>;
  /** The generated skill directories, for the manifest's `skills` (in command order). */
  skillPaths: string[];
  /** The generated skills' names and directories, in the same order. */
  skills: { name: string; dir: string }[];
  /** Per command: `command_imported` or `command_invalid`, then the skill items. */
  items: TranslationItem[];
}

/**
 * Translates the commands (see the file header). `skillNames` are the plugin's imported skills (a
 * skill wins over a command of the same name, as in Claude Code); `room` is how many more skills
 * the plugin may have. `skillItems` adds the per-skill items (manual-only, forked, shell
 * injections, ignored restrictions) the translator reports for skills too.
 */
export function translateClaudeCommands(
  files: ReadonlyMap<string, Uint8Array>,
  commands: { name: string; path?: string; content?: string }[],
  skillNames: ReadonlySet<string>,
  opts: {
    room: number;
    skillItems: (
      component: "command",
      name: string,
      at: { path?: string },
      fm: Readonly<Record<string, unknown>>,
      body: string,
    ) => TranslationItem[];
  },
): TranslatedCommands {
  const generated = new Map<string, Uint8Array>();
  const skillPaths: string[] = [];
  const skills: { name: string; dir: string }[] = [];
  const items: TranslationItem[] = [];
  const taken = new Set<string>();
  for (const c of commands) {
    const at = c.path !== undefined ? { path: c.path } : {};
    const invalid = (problem: string) =>
      items.push(
        item("command_invalid", "command", showName(c.name), { ...at, detail: { problem } }),
      );
    if (!isSkillName(c.name)) {
      invalid(
        "the command name must be 1-64 lowercase letters, digits and single hyphens (commands are never renamed)",
      );
      continue;
    }
    if (skillNames.has(c.name)) {
      invalid("a skill of this plugin has this name; the skill wins, as in Claude Code");
      continue;
    }
    if (taken.has(c.name)) {
      invalid("another command of this plugin has this name");
      continue;
    }
    let text: string | undefined;
    if (c.content !== undefined) text = c.content;
    else if (c.path !== undefined) {
      const data = files.get(c.path);
      if (data === undefined) {
        invalid("file not found");
        continue;
      }
      text = decodeUtf8(data);
      if (text === undefined) {
        invalid("not valid UTF-8 text");
        continue;
      }
    } else {
      invalid("the command has neither a source file nor content");
      continue;
    }
    const parts = readCommand(text);
    if ("problem" in parts) {
      invalid(parts.problem);
      continue;
    }
    const { fm, body } = parts;
    const description =
      typeof fm.description === "string" && fm.description.trim() !== ""
        ? cut(fm.description.replace(/\s+/g, " "), SKILL_LIMITS.descriptionMaxChars)
        : firstLine(body);
    if (description === "") {
      invalid("no description");
      continue;
    }
    if (skills.length >= opts.room) {
      invalid("too many skills");
      continue;
    }
    const front: Record<string, unknown> = { name: c.name, description };
    for (const k of COPIED_KEYS) if (fm[k] !== undefined) front[k] = fm[k];
    const md = `---\n${JSON.stringify(front, null, 2)}\n---\n${body}`;
    const parsed = parseSkillMd(md);
    if ("errors" in parsed) {
      invalid(parsed.errors.join("; "));
      continue;
    }
    taken.add(c.name);
    const dir = `${GENERATED_COMMANDS_DIR}/${c.name}`;
    generated.set(`${dir}/${SKILL_ENTRY_FILE}`, new TextEncoder().encode(md));
    skillPaths.push(dir);
    skills.push({ name: c.name, dir });
    items.push(item("command_imported", "command", c.name, at));
    // The invocation keys as the generated SKILL.md has them; the other keys as the command wrote
    items.push(...opts.skillItems("command", c.name, at, { ...fm, ...parsed.frontmatter }, body));
  }
  return { generated, skillPaths, skills, items };
}
