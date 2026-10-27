import {
  AGENT_TEMPLATE_LIMITS,
  AGENT_TEMPLATE_NAME_RE,
  type AgentTemplate,
  type AgentTemplateTier,
  isSkillName,
  parseAgentTemplate,
} from "@capybara-hq/plugin-sdk";
import { parse as parseYaml } from "yaml";
import { cut, decodeUtf8, isObj, showName } from "./manifest.js";
import { item, type TranslationItem } from "./report.js";

/**
 * Claude Code `agents/*.md` -> Capybara agent templates (sub-agents spec §16.4). Pure: no I/O. The
 * source file is never rewritten: each imported agent becomes a generated template
 * `.capybara-generated/agents/<name>.md` whose frontmatter is the translated fields (written as
 * JSON, which is YAML) and whose body is the source body, byte for byte. Every problem is a report
 * item; nothing here refuses the import.
 */

/** Where the generated templates live. */
export const GENERATED_AGENTS_DIR = ".capybara-generated/agents";

/** Claude Code tool names -> Capybara tool keys (spec §16.4; anything else is dropped). */
const TOOL_MAP: Readonly<Record<string, string>> = {
  Bash: "sandbox_bash",
  Read: "sandbox_read",
  Write: "sandbox_write",
  Edit: "sandbox_edit",
  MultiEdit: "sandbox_edit",
  Glob: "sandbox_glob",
  Grep: "sandbox_grep",
  Skill: "skill_load",
  TodoWrite: "todo__write",
  ToolSearch: "tool_search",
};
/** Claude ignores these for plugin agents: `not_applicable`. */
const NOT_APPLICABLE = new Set(["permissionMode", "hooks", "mcpServers"]);
/** Fields Capybara does not translate: `agent_field_ignored` (with any unknown field). */
const MAPPED = new Set([
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "maxTurns",
  "skills",
  "effort",
]);
const ALIASES: Readonly<Record<string, AgentTemplateTier>> = {
  haiku: "fast",
  sonnet: "standard",
  opus: "capable",
  fable: "capable",
  inherit: "inherit",
};
const FAMILIES: readonly [RegExp, AgentTemplateTier][] = [
  [/haiku/i, "fast"],
  [/sonnet/i, "standard"],
  [/opus|fable/i, "capable"],
];
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const FRONTMATTER_MAX_CHARS = 64 * 1024;

/** One translated agent. */
export interface TranslatedAgent {
  name: string;
  /** The source file. */
  source: string;
  /** The generated template's path. */
  path: string;
  data: Uint8Array;
}

/** Splits a tool list (a YAML list, or a comma separated string; commas inside `(…)` kept). */
function toolNames(v: unknown): string[] | null {
  if (Array.isArray(v))
    return v.every((x) => typeof x === "string") ? v.map((x) => x.trim()) : null;
  if (typeof v !== "string") return null;
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter((x) => x !== "");
}

/** The frontmatter mapping and the raw body (after the closing `---` line), or a problem. */
function split(text: string): { fm: Record<string, unknown>; body: string } | { problem: string } {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const m = /^---[ \t]*\r?\n/.exec(src);
  if (!m) return { problem: "no YAML frontmatter" };
  const rest = src.slice(m[0].length);
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close) return { problem: "the frontmatter is not closed by a '---' line" };
  const front = rest.slice(0, close.index);
  if (front.length > FRONTMATTER_MAX_CHARS) return { problem: "the frontmatter is too long" };
  let data: unknown;
  try {
    data = parseYaml(front, { uniqueKeys: true, maxAliasCount: 50 });
  } catch (e) {
    return { problem: `the frontmatter is not valid YAML: ${String(e).split("\n")[0]}` };
  }
  if (!isObj(data)) return { problem: "the frontmatter is not a YAML mapping" };
  return { fm: data, body: rest.slice(close.index + close[0].length) };
}

/**
 * Translates the agent files at `paths` of plugin `plugin` (in the order given; the first of a name
 * wins). Returns the generated templates and the report items.
 */
export function translateClaudeAgents(
  files: ReadonlyMap<string, Uint8Array>,
  paths: readonly string[],
  plugin: string,
): { agents: TranslatedAgent[]; items: TranslationItem[] } {
  const items: TranslationItem[] = [];
  const agents: TranslatedAgent[] = [];
  for (const source of paths) {
    const base = (source.split("/").pop() as string).replace(/\.md$/, "");
    const at = { path: source };
    const invalid = (label: string, problem: string) =>
      items.push(item("agent_invalid", "agent", showName(label), { ...at, detail: { problem } }));
    const data = files.get(source);
    const text = data === undefined ? undefined : decodeUtf8(data);
    if (text === undefined) {
      invalid(base, data === undefined ? "file not found" : "not valid UTF-8 text");
      continue;
    }
    const parts = split(text);
    if ("problem" in parts) {
      invalid(base, parts.problem);
      continue;
    }
    const { fm, body } = parts;
    const name = fm.name;
    if (typeof name !== "string" || name.trim() === "") {
      invalid(base, "name is required");
      continue;
    }
    if (!AGENT_TEMPLATE_NAME_RE.test(name)) {
      invalid(name, "name must match ^[a-z0-9][a-z0-9-]{0,63}$ (agents are never renamed)");
      continue;
    }
    if (typeof fm.description !== "string" || fm.description.trim() === "") {
      invalid(name, "description is required");
      continue;
    }
    if (agents.some((a) => a.name === name)) {
      invalid(name, `the name ${name} is also used by another agent of this plugin`);
      continue;
    }
    if (agents.length >= AGENT_TEMPLATE_LIMITS.perPlugin) {
      invalid(name, `a plugin may have at most ${AGENT_TEMPLATE_LIMITS.perPlugin} agents`);
      continue;
    }
    const add = (code: Parameters<typeof item>[0], detail: Record<string, string>) =>
      items.push(item(code, "agent", name, { ...at, detail }));

    const out: Omit<AgentTemplate, "instructions"> = {
      name,
      description: cut(fm.description, AGENT_TEMPLATE_LIMITS.descriptionChars),
    };
    const ignored: string[] = [];
    const unmapped: string[] = [];
    const narrowed: string[] = [];
    // tools: an allowlist; a pattern such as Bash(git:*) is dropped (mapping it would widen it)
    if (fm.tools !== undefined) {
      const names = toolNames(fm.tools);
      if (names === null) ignored.push("tools");
      // "*" anywhere (Claude's wildcard) inherits the parent's tools: never wider, but said
      else if (names.includes("*")) add("agent_tools_inherited", {});
      else {
        const keys: string[] = [];
        for (const n of names) {
          const k = TOOL_MAP[n];
          if (k === undefined) unmapped.push(n);
          else if (!keys.includes(k)) keys.push(k);
        }
        out.tools = keys;
      }
    }
    // disallowedTools: a pattern disallows its whole tool (narrower, never wider)
    if (fm.disallowedTools !== undefined) {
      const names = toolNames(fm.disallowedTools);
      if (names === null) ignored.push("disallowedTools");
      else {
        const keys: string[] = [];
        for (const n of names) {
          const k = TOOL_MAP[n.replace(/\(.*$/s, "").trim()];
          if (k === undefined) unmapped.push(n);
          else if (!keys.includes(k)) keys.push(k);
          if (k !== undefined && n.includes("(")) narrowed.push(n);
        }
        if (keys.length > 0) out.disallowedTools = keys;
      }
    }
    if (fm.model !== undefined) {
      const raw = typeof fm.model === "string" ? fm.model.trim() : "";
      const alias = ALIASES[raw];
      if (alias !== undefined) out.model = alias;
      else {
        const tier = FAMILIES.find(([re]) => re.test(raw))?.[1] ?? "inherit";
        out.model = tier;
        add("agent_model_mapped", { from: showName(raw || String(fm.model)), to: tier });
      }
    }
    if (fm.maxTurns !== undefined) {
      if (Number.isInteger(fm.maxTurns) && (fm.maxTurns as number) >= 1) {
        out.maxSteps = fm.maxTurns as number;
      } else ignored.push("maxTurns");
    }
    if (fm.effort !== undefined) {
      if (typeof fm.effort === "string" && EFFORTS.has(fm.effort)) {
        out.effort = fm.effort as NonNullable<AgentTemplate["effort"]>;
      } else ignored.push("effort");
    }
    if (fm.skills !== undefined) {
      const list = toolNames(fm.skills);
      if (list === null) ignored.push("skills");
      else {
        const kept: string[] = [];
        const dropped: string[] = [];
        for (const s of list) {
          const own = s.startsWith(`${plugin}:`) ? s.slice(plugin.length + 1) : s;
          if (isSkillName(own) && kept.length < AGENT_TEMPLATE_LIMITS.skills && !kept.includes(own))
            kept.push(own);
          else dropped.push(s);
        }
        if (kept.length > 0) out.skills = kept;
        if (dropped.length > 0) add("agent_skills_truncated", { skills: dropped.join(", ") });
      }
    }
    const notApplicable = Object.keys(fm).filter((k) => NOT_APPLICABLE.has(k));
    ignored.push(...Object.keys(fm).filter((k) => !MAPPED.has(k) && !NOT_APPLICABLE.has(k)));
    if (unmapped.length > 0) add("agent_tools_unmapped", { tools: unmapped.join(", ") });
    if (narrowed.length > 0) add("agent_tools_narrowed", { tools: narrowed.join(", ") });
    if (notApplicable.length > 0) {
      add("not_applicable", { keys: notApplicable.sort().join(", ") });
    }
    if (ignored.length > 0) {
      add("agent_field_ignored", { keys: ignored.map(showName).sort().join(", ") });
    }

    // The generated template: translated frontmatter (JSON is YAML), the body unchanged
    const generated = `---\n${JSON.stringify(out, null, 2)}\n---\n${body}`;
    const check = parseAgentTemplate(generated);
    if ("errors" in check) {
      invalid(name, check.errors.join("; "));
      continue;
    }
    agents.push({
      name,
      source,
      path: `${GENERATED_AGENTS_DIR}/${name}.md`,
      data: new TextEncoder().encode(generated),
    });
    items.push(
      item("agent_imported", "agent", name, {
        ...at,
        detail: { type: `${plugin}:${name}`, model: out.model ?? "inherit" },
      }),
    );
  }
  return { agents, items };
}
