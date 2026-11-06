/**
 * Agent templates (`agents/<name>.md` in a plugin; sub-agents spec §16.1): Markdown with YAML
 * frontmatter, the body being the instructions. A template is a type an agent with the builtin
 * `Agent` tool can dispatch as a sub-agent (`<plugin>:<name>` in its roster). Used by the kernel,
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
  /** Further skill names the agent uses (not preloaded; P4-1). */
  selectedSkills?: string[];
  /** Connectors the agent needs: a connector template of the plugin, or a described need. */
  connectors?: AgentTemplateConnector[];
  /** The sub-agents the agent gets in its roster. */
  subagents?: AgentTemplateSubagents;
  /** `provider/model`: the concrete model an org template was saved with. */
  modelRef?: string;
  /** The agent profile's quick actions (same shape and limits). */
  quickActions?: AgentTemplateQuickAction[];
  /** The agent's instruction files. */
  instructionFiles?: AgentTemplateInstructionFile[];
}

/** A quick action of the agent profile. */
export interface AgentTemplateQuickAction {
  title: string;
  body: string;
}

/** An instruction file of the agent. */
export interface AgentTemplateInstructionFile {
  name: string;
  content: string;
}

/** A connector entry of a template: a connector template id (`<id>` or `<plugin>:<id>`) or a need. */
export type AgentTemplateConnector =
  | { template: string; tools?: string[] }
  | {
      needs: {
        protocol: "mcp" | "openapi";
        endpoint: string;
        tools: string[];
        label: string;
      };
    };

/** A sub-agent type described inside a template. */
export interface AgentTemplateInlineSubagent {
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  /** Skill names. */
  skills: string[];
  model: AgentTemplateTier;
}

export interface AgentTemplateSubagents {
  general?: boolean;
  /** Template types as the roster writes them (`<plugin>:<name>` or `<name>`). */
  types?: string[];
  inline?: AgentTemplateInlineSubagent[];
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
  /** Entries of `selectedSkills`. */
  selectedSkills: 32,
  /** Entries of `connectors`. */
  connectors: 16,
  /** `subagents.types` plus `subagents.inline`. */
  subagentTypes: 16,
  /** Characters of one inline sub-agent's instructions. */
  inlineInstructionsChars: 100_000,
  /** Tools named by a connector entry. */
  connectorTools: 200,
  /** Quick actions, as the agent profile limits them. */
  quickActions: 9,
  quickActionTitleChars: 40,
  quickActionBodyChars: 20_000,
  /** Instruction files and their joined size, as the agent limits them. */
  instructionFiles: 20,
  instructionFilesChars: 100_000,
} as const;

/** The name rule of a template (the catalog item name rule). */
export const AGENT_TEMPLATE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const TIERS: readonly AgentTemplateTier[] = ["inherit", "fast", "standard", "capable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Room for sub-agents described inline (up to 16 x 100 000 characters of instructions, P4-1). */
const FRONTMATTER_MAX_CHARS = 2 * 1024 * 1024;
/** The kernel's tool key rule (model-visible keys): no dots, no whitespace, at most 64 chars. */
const TOOL_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const distinct = (v: readonly unknown[]) => new Set(v).size === v.length;
const NAME_REF_RE = /^[a-z0-9][a-z0-9-]{0,63}(:[a-z0-9][a-z0-9-]{0,63})?$/;
const MODEL_REF_RE = /^[^/\s]+\/\S+$/;
/** The name rule of an instruction file (the agent's rule, mirrored). */
export const AGENT_TEMPLATE_INSTRUCTION_FILE_NAME_RE = /^[^/\\]{1,64}\.md$/;

const chars = (s: string) => [...s].length;
const isToolKey = (v: unknown): v is string => typeof v === "string" && TOOL_KEY_RE.test(v);
const toolList = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length <= AGENT_TEMPLATE_LIMITS.tools &&
  v.every(isToolKey) &&
  new Set(v).size === v.length;
const toolListRule = `a list of at most ${AGENT_TEMPLATE_LIMITS.tools} distinct tool keys (letters, digits, _ and -, up to 64 characters)`;

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
    else errors.push(`tools must be ${toolListRule}`);
  }
  if (fm.disallowedTools !== undefined) {
    if (toolList(fm.disallowedTools)) out.disallowedTools = fm.disallowedTools;
    else errors.push(`disallowedTools must be ${toolListRule}`);
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
    if (Array.isArray(s) && s.length <= L.skills && s.every(isSkillName) && distinct(s))
      out.skills = s;
    else errors.push(`skills must list at most ${L.skills} skill names`);
  }

  if (fm.selectedSkills !== undefined) {
    const s = fm.selectedSkills;
    if (Array.isArray(s) && s.length <= L.selectedSkills && s.every(isSkillName) && distinct(s)) {
      out.selectedSkills = s;
    } else errors.push(`selectedSkills must list at most ${L.selectedSkills} skill names`);
  }
  if (fm.connectors !== undefined) {
    const c = readConnectors(fm.connectors, errors);
    if (c) out.connectors = c;
  }
  if (fm.subagents !== undefined) {
    const s = readSubagents(fm.subagents, errors);
    if (s) out.subagents = s;
  }
  if (fm.modelRef !== undefined) {
    if (
      typeof fm.modelRef === "string" &&
      fm.modelRef.length <= 200 &&
      MODEL_REF_RE.test(fm.modelRef)
    ) {
      out.modelRef = fm.modelRef;
    } else errors.push("modelRef must be <provider>/<model>");
  }
  if (fm.quickActions !== undefined) {
    const q = readQuickActions(fm.quickActions, errors);
    if (q) out.quickActions = q;
  }
  if (fm.instructionFiles !== undefined) {
    const f = readInstructionFiles(fm.instructionFiles, errors);
    if (f) out.instructionFiles = f;
  }

  if (errors.length > 0) return { errors };
  return { template: out };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim() !== "" && chars(v) <= max;
const strList = (v: unknown, max: number, itemMax: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((x) => isStr(x, itemMax));

function readConnectors(v: unknown, errors: string[]): AgentTemplateConnector[] | undefined {
  const L = AGENT_TEMPLATE_LIMITS;
  if (!Array.isArray(v) || v.length > L.connectors) {
    errors.push(`connectors must be a list of at most ${L.connectors} entries`);
    return undefined;
  }
  const out: AgentTemplateConnector[] = [];
  let ok = true;
  v.forEach((e, i) => {
    const at = `connectors[${i}]`;
    if (!isObj(e)) {
      errors.push(`${at} must be { template } or { needs }`);
      ok = false;
    } else if ("template" in e) {
      if (typeof e.template !== "string" || !NAME_REF_RE.test(e.template)) {
        errors.push(`${at}.template must be a connector template id (<id> or <plugin>:<id>)`);
        ok = false;
      } else if (e.tools !== undefined && !strList(e.tools, L.connectorTools, 128)) {
        errors.push(`${at}.tools must list at most ${L.connectorTools} tool names`);
        ok = false;
      } else {
        out.push({
          template: e.template,
          ...(e.tools !== undefined && { tools: e.tools as string[] }),
        });
      }
    } else if ("needs" in e) {
      const n = e.needs;
      if (!isObj(n)) {
        errors.push(`${at}.needs must be an object`);
        ok = false;
      } else if (n.protocol !== "mcp" && n.protocol !== "openapi") {
        errors.push(`${at}.needs.protocol must be mcp or openapi`);
        ok = false;
      } else if (!isStr(n.endpoint, 2048)) {
        errors.push(`${at}.needs.endpoint must be a non-empty string of at most 2048 characters`);
        ok = false;
      } else if (!strList(n.tools, L.connectorTools, 128)) {
        errors.push(`${at}.needs.tools must list at most ${L.connectorTools} tool names`);
        ok = false;
      } else if (!isStr(n.label, 80)) {
        errors.push(`${at}.needs.label must be a non-empty string of at most 80 characters`);
        ok = false;
      } else {
        out.push({
          needs: {
            protocol: n.protocol,
            endpoint: n.endpoint,
            tools: n.tools as string[],
            label: n.label,
          },
        });
      }
    } else {
      errors.push(`${at} must have template or needs`);
      ok = false;
    }
  });
  return ok ? out : undefined;
}

function readSubagents(v: unknown, errors: string[]): AgentTemplateSubagents | undefined {
  const L = AGENT_TEMPLATE_LIMITS;
  if (!isObj(v)) {
    errors.push("subagents must be an object");
    return undefined;
  }
  const out: AgentTemplateSubagents = {};
  const n0 = errors.length;
  if (v.general !== undefined) {
    if (typeof v.general === "boolean") out.general = v.general;
    else errors.push("subagents.general must be true or false");
  }
  if (v.types !== undefined) {
    if (
      Array.isArray(v.types) &&
      v.types.every((t) => typeof t === "string" && NAME_REF_RE.test(t)) &&
      distinct(v.types)
    ) {
      out.types = v.types as string[];
    } else errors.push("subagents.types must list sub-agent type names");
  }
  if (v.inline !== undefined) {
    if (!Array.isArray(v.inline)) errors.push("subagents.inline must be a list");
    else {
      const inline: AgentTemplateInlineSubagent[] = [];
      v.inline.forEach((e, i) => {
        const at = `subagents.inline[${i}]`;
        if (!isObj(e)) {
          errors.push(`${at} must be an object`);
          return;
        }
        const before = errors.length;
        if (typeof e.name !== "string" || !AGENT_TEMPLATE_NAME_RE.test(e.name)) {
          errors.push(`${at}.name must match ^[a-z0-9][a-z0-9-]{0,63}$`);
        }
        if (!isStr(e.description, L.descriptionChars)) {
          errors.push(
            `${at}.description must be a non-empty string of at most ${L.descriptionChars} characters`,
          );
        }
        if (
          typeof e.instructions !== "string" ||
          e.instructions.trim() === "" ||
          chars(e.instructions) > L.inlineInstructionsChars
        ) {
          errors.push(
            `${at}.instructions must be a non-empty string of at most ${L.inlineInstructionsChars} characters`,
          );
        }
        if (!toolList(e.tools)) errors.push(`${at}.tools must be ${toolListRule}`);
        if (
          !(
            Array.isArray(e.skills) &&
            e.skills.length <= L.skills &&
            e.skills.every(isSkillName) &&
            distinct(e.skills)
          )
        ) {
          errors.push(`${at}.skills must list at most ${L.skills} skill names`);
        }
        if (!TIERS.includes(e.model as AgentTemplateTier)) {
          errors.push(`${at}.model must be one of ${TIERS.join(", ")}`);
        }
        if (errors.length === before) inline.push(e as unknown as AgentTemplateInlineSubagent);
      });
      out.inline = inline;
    }
  }
  if ((out.types?.length ?? 0) + (out.inline?.length ?? 0) > L.subagentTypes) {
    errors.push(`subagents.types and subagents.inline together must be at most ${L.subagentTypes}`);
  }
  return errors.length === n0 ? out : undefined;
}

function readQuickActions(v: unknown, errors: string[]): AgentTemplateQuickAction[] | undefined {
  const L = AGENT_TEMPLATE_LIMITS;
  if (!Array.isArray(v) || v.length > L.quickActions) {
    errors.push(`quickActions must be a list of at most ${L.quickActions} entries`);
    return undefined;
  }
  const n0 = errors.length;
  const out: AgentTemplateQuickAction[] = [];
  v.forEach((e, i) => {
    if (
      isObj(e) &&
      isStr(e.title, L.quickActionTitleChars) &&
      isStr(e.body, L.quickActionBodyChars)
    ) {
      out.push({ title: e.title, body: e.body });
    } else {
      errors.push(
        `quickActions[${i}] must have a title (at most ${L.quickActionTitleChars} characters) and a body (at most ${L.quickActionBodyChars})`,
      );
    }
  });
  return errors.length === n0 ? out : undefined;
}

function readInstructionFiles(
  v: unknown,
  errors: string[],
): AgentTemplateInstructionFile[] | undefined {
  const L = AGENT_TEMPLATE_LIMITS;
  if (!Array.isArray(v) || v.length > L.instructionFiles) {
    errors.push(`instructionFiles must be a list of at most ${L.instructionFiles} entries`);
    return undefined;
  }
  const n0 = errors.length;
  const out: AgentTemplateInstructionFile[] = [];
  let total = 0;
  v.forEach((e, i) => {
    if (
      isObj(e) &&
      typeof e.name === "string" &&
      AGENT_TEMPLATE_INSTRUCTION_FILE_NAME_RE.test(e.name) &&
      typeof e.content === "string"
    ) {
      total += chars(e.content);
      out.push({ name: e.name, content: e.content });
    } else {
      errors.push(`instructionFiles[${i}] must have a name (<name>.md) and a content string`);
    }
  });
  if (errors.length === n0 && total > L.instructionFilesChars) {
    errors.push(`instructionFiles must total at most ${L.instructionFilesChars} characters`);
  }
  return errors.length === n0 ? out : undefined;
}
