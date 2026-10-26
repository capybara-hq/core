/**
 * Agent templates (`agents/<name>.md` in a plugin; sub-agents spec §16.1): Markdown with YAML
 * frontmatter, the body being the instructions. A template is a type an agent with the builtin
 * `agent` tool can dispatch as a sub-agent (`<plugin>:<name>` in its roster). Used by the kernel,
 * the packer and `capybara-plugin check`.
 */
import { readFrontmatter } from "./frontmatter.js";
import { isSkillName } from "./skill.js";

/** The model tier of a template: a kernel purpose, never a model id (spec §5.4). */
export type AgentTemplateTier = "inherit" | "fast" | "standard" | "capable";

/** A parsed agent template. Optional fields are absent when the frontmatter omits them. */
export interface AgentTemplate {
  /** `^[a-z0-9][a-z0-9-]{0,63}$`; the type name is `<plugin>:<name>`. */
  name: string;
  /** When to use it (trimmed, at most 4096 characters). */
  description: string;
  /** The body after the frontmatter, unchanged. */
  instructions: string;
  /** Tool keys allowed (an allowlist); omitted = the parent's tools. */
  tools?: string[];
  /** Tool keys removed. */
  disallowedTools?: string[];
  /** Tightened policies by tool key. */
  toolPolicies?: Record<string, "ask" | "deny">;
  /** Default `inherit`. */
  model?: AgentTemplateTier;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Step limit (the kernel caps it at `runtime.maxSteps`). */
  maxSteps?: number;
  /** Skill names preloaded (pinned) in the sub-agent. */
  skills?: string[];
}

/** Limits of agent templates. */
export const AGENT_TEMPLATE_LIMITS = {
  /** Characters of the body (instructions). */
  bodyChars: 100_000,
  descriptionChars: 4096,
  /** Templates in one plugin. */
  perPlugin: 64,
  /** Preloaded skills. */
  skills: 3,
  /** Entries of `tools` and of `disallowedTools`. */
  tools: 200,
} as const;

/** The name rule of a template (the catalog item name rule). */
export const AGENT_TEMPLATE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const TIERS: readonly AgentTemplateTier[] = ["inherit", "fast", "standard", "capable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const FRONTMATTER_MAX_CHARS = 64 * 1024;
const TOOL_KEY_MAX_CHARS = 200;

const chars = (s: string) => [...s].length;
const isToolKey = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= TOOL_KEY_MAX_CHARS;
const toolList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= AGENT_TEMPLATE_LIMITS.tools && v.every(isToolKey);

/**
 * Parses an agent template file. Returns the template, or every problem found (English, for the
 * plugin author or an admin). Keys the format does not define are ignored. Never throws.
 */
export function parseAgentTemplate(
  text: string,
): { template: AgentTemplate } | { errors: string[] } {
  const read = readFrontmatter(text, "an agent template", FRONTMATTER_MAX_CHARS);
  if ("errors" in read) return read;
  const { frontmatter: fm, body } = read;
  const errors: string[] = [];
  const L = AGENT_TEMPLATE_LIMITS;

  const name = fm.name;
  if (name === undefined || name === null) errors.push("name is required");
  else if (typeof name !== "string" || !AGENT_TEMPLATE_NAME_RE.test(name)) {
    errors.push("name must match ^[a-z0-9][a-z0-9-]{0,63}$");
  }

  let description = "";
  if (fm.description === undefined || fm.description === null) {
    errors.push("description is required");
  } else if (typeof fm.description !== "string" || fm.description.trim() === "") {
    errors.push("description must be a non-empty string");
  } else {
    description = fm.description.trim();
    if (chars(description) > L.descriptionChars) {
      errors.push(`description must be at most ${L.descriptionChars} characters`);
    }
  }

  if (chars(body) > L.bodyChars) {
    errors.push(`the body (instructions) must be at most ${L.bodyChars} characters`);
  }

  const out: AgentTemplate = { name: name as string, description, instructions: body };

  if (fm.tools !== undefined) {
    if (toolList(fm.tools)) out.tools = fm.tools;
    else errors.push(`tools must be a list of at most ${L.tools} tool keys`);
  }
  if (fm.disallowedTools !== undefined) {
    if (toolList(fm.disallowedTools)) out.disallowedTools = fm.disallowedTools;
    else errors.push(`disallowedTools must be a list of at most ${L.tools} tool keys`);
  }
  if (fm.toolPolicies !== undefined) {
    const p = fm.toolPolicies;
    const ok =
      p !== null &&
      typeof p === "object" &&
      !Array.isArray(p) &&
      Object.keys(p).length <= L.tools &&
      Object.entries(p).every(([k, v]) => isToolKey(k) && (v === "ask" || v === "deny"));
    if (ok) out.toolPolicies = { ...(p as Record<string, "ask" | "deny">) };
    else errors.push("toolPolicies must map tool keys to ask or deny");
  }
  if (fm.model !== undefined) {
    if (TIERS.includes(fm.model as AgentTemplateTier)) out.model = fm.model as AgentTemplateTier;
    else errors.push(`model must be one of ${TIERS.join(", ")}`);
  }
  if (fm.effort !== undefined) {
    if ((EFFORTS as readonly unknown[]).includes(fm.effort)) {
      out.effort = fm.effort as (typeof EFFORTS)[number];
    } else errors.push(`effort must be one of ${EFFORTS.join(", ")}`);
  }
  if (fm.maxSteps !== undefined) {
    if (Number.isInteger(fm.maxSteps) && (fm.maxSteps as number) >= 1) {
      out.maxSteps = fm.maxSteps as number;
    } else errors.push("maxSteps must be an integer of at least 1");
  }
  if (fm.skills !== undefined) {
    const s = fm.skills;
    if (Array.isArray(s) && s.length <= L.skills && s.every(isSkillName)) out.skills = s;
    else errors.push(`skills must list at most ${L.skills} skill names`);
  }

  if (errors.length > 0) return { errors };
  return { template: out };
}
