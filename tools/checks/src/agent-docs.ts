import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AGENT_TEMPLATE_FIELDS,
  type AgentTemplateField,
  EXTENSION_POINTS,
  type ExtensionPointInfo,
} from "@capybara-hq/plugin-sdk";
import type { Finding } from "./source.js";

/**
 * Agent docs guard (Platform tool spec §8, §9): `packages/plugin-sdk/agent-docs/` holds the
 * Markdown topics the `Platform` tool's `read` action serves to agents. The prose is hand-written;
 * the sections between `<!-- generated:<name> -->` and `<!-- /generated -->` are rendered from the
 * SDK's JSON Schemas and the `EXTENSION_POINTS` table by `pnpm gen:agent-docs`. Rules:
 *
 * - agent-docs-stale: a generated section differs from what the generator renders (edited by
 *   hand, or the source changed);
 * - agent-docs-missing: an extension point without its topic or table row, a fixed topic without
 *   its file, a generated section a topic must carry, a field of plugin.v1 / connector-template.v1 /
 *   the agent template absent from its table, or a title not starting with 'Authoring:' (`concepts`
 *   aside; using the platform is covered by operations);
 * - agent-docs-orphan: a topic, or a row (generated or in a hand-written table), for an extension
 *   point or plugin-format field that no longer exists in the code.
 *
 * Hand-written tables (a `| Field |` table in plugin-format / connector-templates / agent-templates,
 * an `| Extension point |` table anywhere) are checked for orphans only: a row naming something gone
 * from the code fails, but a hand table need not list every field. Completeness is the generated
 * sections' job.
 */

export const AGENT_DOCS_DIR = "packages/plugin-sdk/agent-docs";
const SCHEMAS_DIR = "packages/plugin-sdk/schemas";

/** The hand-written topics every deployment serves. */
export const FIXED_TOPICS = [
  "concepts",
  "plugin-format",
  "skills",
  "agent-templates",
  "connector-templates",
  "tool-naming",
  "extensions",
] as const;

/** The generated section a topic must carry, by topic id (extension points: see below). */
const REQUIRED_SECTIONS: Record<string, string> = {
  "plugin-format": "plugin-manifest",
  "connector-templates": "connector-template",
  "agent-templates": "agent-template",
  extensions: "extension-points",
};

export interface AgentDocsOptions {
  /** The extension point table; default: the SDK's `EXTENSION_POINTS`. */
  points?: Record<string, ExtensionPointInfo>;
  /** The agent template frontmatter keys; default: the SDK's `AGENT_TEMPLATE_FIELDS`. */
  agentTemplateFields?: readonly AgentTemplateField[];
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

const SECTION_RE = /<!-- generated:([a-z0-9-]+) -->\n([\s\S]*?)<!-- \/generated -->/g;

interface JsonSchemaLike {
  properties?: Record<string, unknown>;
  required?: string[];
}

function typeOf(s: unknown): string {
  if (typeof s !== "object" || s === null) return "any";
  const o = s as Record<string, unknown>;
  if ("const" in o) return `\`${JSON.stringify(o.const)}\``;
  if (Array.isArray(o.enum)) return o.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" \\| ");
  if (Array.isArray(o.anyOf)) return [...new Set(o.anyOf.map(typeOf))].join(" or ");
  if (o.type === "array") return `array of ${typeOf(o.items)}`;
  if (typeof o.type === "string") return o.type;
  return "any";
}

function schemaFields(root: string, file: string): { name: string; type: string; req: boolean }[] {
  const path = join(root, SCHEMAS_DIR, file);
  if (!existsSync(path)) return [];
  const schema = JSON.parse(readFileSync(path, "utf8")) as JsonSchemaLike;
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {})
    .filter(([name]) => name !== "$schema")
    .map(([name, s]) => ({ name, type: typeOf(s), req: required.has(name) }));
}

function fieldTable(root: string, file: string): string {
  const rows = schemaFields(root, file).map(
    (f) => `| \`${f.name}\` | ${f.type} | ${f.req ? "yes" : "no"} |`,
  );
  return ["| Field | Type | Required |", "|---|---|---|", ...rows, ""].join("\n");
}

function pointsTable(points: Record<string, ExtensionPointInfo>): string {
  const rows = Object.entries(points).map(
    ([name, p]) =>
      `| \`${name}\` | ${p.cardinality} | ${p.orgScoped ? "yes" : "no"} | ${cell(p.description)} |`,
  );
  return [
    "| Extension point | Providers | Per org | What it is |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function pointSummary(name: string, p: ExtensionPointInfo): string {
  return [
    `- Name: \`${name}\` (a ref is \`${name}@<major>\`)`,
    `- ${cell(p.description)}`,
    `- Providers: ${p.cardinality === "single" ? "one at a time" : "several"}${
      p.selection === "org-default" ? "; each org chooses its default" : ""
    }`,
    `- Enabled per org: ${p.orgScoped ? "yes" : "no"}`,
    `- Brokered by the platform: ${p.brokered ? "yes (extensions use it only through `ctx`)" : "no"}`,
    "",
  ].join("\n");
}

/** What a generated section named `name` in the topic `topic` should contain; null = unknown. */
function render(
  root: string,
  name: string,
  topic: string,
  points: Record<string, ExtensionPointInfo>,
  templateFields: readonly AgentTemplateField[],
): string | null {
  if (name === "plugin-manifest") return fieldTable(root, "plugin.v1.schema.json");
  if (name === "connector-template") return fieldTable(root, "connector-template.v1.schema.json");
  if (name === "agent-template") {
    const rows = templateFields.map(
      (f) =>
        `| \`${f.name}\` | ${f.type} | ${f.required ? "yes" : "no"} | ${cell(f.description)} |`,
    );
    return ["| Field | Type | Required | Meaning |", "|---|---|---|---|", ...rows, ""].join("\n");
  }
  if (name === "extension-points") return pointsTable(points);
  if (name === "extension-point") {
    const key = topic.replace(/^extension-points\//, "");
    const p = points[key];
    return p ? pointSummary(key, p) : null;
  }
  return null;
}

function topicFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      for (const f of readdirSync(join(dir, e.name))) {
        if (f.endsWith(".md")) out.push(`${e.name}/${f}`);
      }
    } else if (e.name.endsWith(".md")) out.push(e.name);
  }
  return out.sort();
}

/** What a generated table's rows are, by section name (for messages). */
const KEY_KIND: Record<string, string> = {
  "plugin-manifest": "plugin.v1 field",
  "connector-template": "connector-template.v1 field",
  "agent-template": "agent template field",
  "extension-points": "extension point",
};

/** The first-cell names of the table rows in `text`, in order. */
function rowKeys(text: string): string[] {
  return [...text.matchAll(/^\| `([^`|]+)` \|/gm)].map((m) => m[1] as string);
}

/** Hand-written tables outside generated sections: the rows of tables whose header starts `header`. */
function handRows(text: string, header: string): { key: string; line: number }[] {
  const masked = text.replace(SECTION_RE, (all) => all.replace(/[^\n]/g, " "));
  const out: { key: string; line: number }[] = [];
  let inTable = false;
  masked.split("\n").forEach((l, i) => {
    if (l.startsWith(`| ${header} |`)) inTable = true;
    else if (!l.startsWith("|")) inTable = false;
    else if (inTable) {
      const m = /^\| `([^`|]+)` \|/.exec(l);
      if (m) out.push({ key: m[1] as string, line: i + 1 });
    }
  });
  return out;
}

const topicId = (file: string) => file.replace(/\.md$/, "");
const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

export function checkAgentDocs(root: string, opts: AgentDocsOptions = {}): Finding[] {
  const points = opts.points ?? EXTENSION_POINTS;
  const templateFields = opts.agentTemplateFields ?? AGENT_TEMPLATE_FIELDS;
  const dir = join(root, AGENT_DOCS_DIR);
  const findings: Finding[] = [];
  const add = (rule: string, file: string, line: number, message: string) =>
    findings.push({ rule, file, line, message });
  const files = new Set(topicFiles(dir));

  for (const t of FIXED_TOPICS) {
    if (!files.has(`${t}.md`)) {
      add("agent-docs-missing", join(dir, `${t}.md`), 1, `topic "${t}" has no file`);
    }
  }
  for (const name of Object.keys(points)) {
    if (!files.has(`extension-points/${name}.md`)) {
      add(
        "agent-docs-missing",
        join(dir, "extension-points", `${name}.md`),
        1,
        `extension point "${name}" has no topic; write it, then run pnpm gen:agent-docs`,
      );
    }
  }

  for (const file of files) {
    const id = topicId(file);
    const path = join(dir, file);
    if (id.startsWith("extension-points/") && !points[id.slice("extension-points/".length)]) {
      add(
        "agent-docs-orphan",
        path,
        1,
        `no extension point "${id.slice("extension-points/".length)}" exists; delete this topic`,
      );
      continue;
    }
    const text = readFileSync(path, "utf8");
    const required = id.startsWith("extension-points/") ? "extension-point" : REQUIRED_SECTIONS[id];
    const seen = new Set<string>();
    for (const m of text.matchAll(SECTION_RE)) {
      const name = m[1] as string;
      const body = m[2] as string;
      const line = lineAt(text, m.index);
      seen.add(name);
      const expected = render(root, name, id, points, templateFields);
      if (expected === null) {
        add("agent-docs-stale", path, line, `unknown generated section "${name}" in topic "${id}"`);
        continue;
      }
      if (body === expected) continue;
      const wanted = rowKeys(expected);
      const have = rowKeys(body);
      const what = KEY_KIND[name] ?? "row";
      let explained = false;
      for (const k of wanted) {
        if (!have.includes(k)) {
          explained = true;
          add(
            "agent-docs-missing",
            path,
            line,
            `${what} "${k}" is in the code but absent from the "${name}" table; run pnpm gen:agent-docs`,
          );
        }
      }
      for (const k of have) {
        if (!wanted.includes(k)) {
          explained = true;
          add(
            "agent-docs-orphan",
            path,
            line,
            `${what} "${k}" is in the "${name}" table but gone from the code; run pnpm gen:agent-docs`,
          );
        }
      }
      if (!explained) {
        add(
          "agent-docs-stale",
          path,
          line,
          `generated section "${name}" is not what the generator renders; run pnpm gen:agent-docs (never edit it by hand)`,
        );
      }
    }
    const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? "";
    if (id !== "concepts" && !title.startsWith("Authoring:")) {
      add(
        "agent-docs-missing",
        path,
        1,
        `topic "${id}" title "${title}" must start with "Authoring:" (using the platform is covered by operations)`,
      );
    }
    const fieldSet: Record<string, string[]> = {
      "plugin-format": schemaFields(root, "plugin.v1.schema.json").map((f) => f.name),
      "connector-templates": schemaFields(root, "connector-template.v1.schema.json").map(
        (f) => f.name,
      ),
      "agent-templates": templateFields.map((f) => f.name),
    };
    const known = fieldSet[id];
    if (known) {
      for (const r of handRows(text, "Field")) {
        if (!known.includes(r.key)) {
          add(
            "agent-docs-orphan",
            path,
            r.line,
            `field "${r.key}" has a row in a hand-written table but is gone from the code; delete the row`,
          );
        }
      }
    }
    for (const r of handRows(text, "Extension point")) {
      if (!points[r.key]) {
        add(
          "agent-docs-orphan",
          path,
          r.line,
          `extension point "${r.key}" has a row in a hand-written table but no longer exists; delete the row`,
        );
      }
    }
    if (required && !seen.has(required)) {
      add(
        "agent-docs-missing",
        path,
        1,
        `topic "${id}" must carry the generated section "${required}"`,
      );
    }
  }
  return findings;
}

/** Rewrites every generated section the generator knows; returns the files that changed. */
export function generateAgentDocs(root: string, opts: AgentDocsOptions = {}): string[] {
  const points = opts.points ?? EXTENSION_POINTS;
  const templateFields = opts.agentTemplateFields ?? AGENT_TEMPLATE_FIELDS;
  const dir = join(root, AGENT_DOCS_DIR);
  const changed: string[] = [];
  for (const file of topicFiles(dir)) {
    const id = topicId(file);
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");
    const next = text.replace(SECTION_RE, (all, name: string) => {
      const body = render(root, name, id, points, templateFields);
      return body === null ? all : `<!-- generated:${name} -->\n${body}<!-- /generated -->`;
    });
    if (next !== text) {
      writeFileSync(path, next);
      changed.push(path);
    }
  }
  return changed;
}

/** Writes a stub topic for every extension point that has none (the author then fills it in). */
export function scaffoldPointTopics(root: string, opts: AgentDocsOptions = {}): string[] {
  const points = opts.points ?? EXTENSION_POINTS;
  const created: string[] = [];
  for (const name of Object.keys(points)) {
    const path = join(root, AGENT_DOCS_DIR, "extension-points", `${name}.md`);
    if (existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `# Authoring: extension point ${name}\n\n<!-- generated:extension-point -->\n<!-- /generated -->\n`,
    );
    created.push(path);
  }
  return created;
}
