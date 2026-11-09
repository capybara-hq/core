import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionPointInfo } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { AGENT_DOCS_DIR, checkAgentDocs } from "../src/agent-docs.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/agent-docs/${name}`, import.meta.url));

const point = (description: string): ExtensionPointInfo => ({
  description,
  cardinality: "multi",
  brokered: false,
  orgScoped: true,
  majors: [1],
});
const points = { alpha: point("Alpha does a thing | really.") };
const agentTemplateFields = [
  { name: "name", type: "string", required: true, description: "The name." },
  { name: "tools", type: "array", required: false, description: "Tools." },
];

describe("checkAgentDocs", () => {
  it("passes when every generated section matches and every topic exists", () => {
    expect(checkAgentDocs(fixture("clean"), { points, agentTemplateFields })).toEqual([]);
  });

  it("reports a hand-edited section, a missing topic or field, and an orphan topic", () => {
    const root = fixture("violations");
    const docs = join(root, AGENT_DOCS_DIR);
    const f = checkAgentDocs(root, {
      points: { ...points, gamma: point("Gamma.") },
      agentTemplateFields,
    });
    expect(f.map((x) => [x.rule, x.file.slice(docs.length + 1)]).sort()).toEqual(
      [
        ["agent-docs-missing", "extensions.md"],
        ["agent-docs-missing", "plugin-format.md"],
        ["agent-docs-missing", "agent-templates.md"],
        ["agent-docs-missing", "connector-templates.md"],
        ["agent-docs-stale", "skills.md"],
        ["agent-docs-missing", "extension-points/gamma.md"],
        ["agent-docs-orphan", "extension-points/beta.md"],
      ].sort(),
    );
    const tpl = f.find((x) => x.file.endsWith("agent-templates.md"));
    expect(tpl?.message).toContain('"tools"');
    expect(f.find((x) => x.file.endsWith("skills.md"))?.message).toContain("unknown");
    expect(f.find((x) => x.file.endsWith("connector-templates.md"))?.message).toContain(
      "must carry",
    );
    const missing = f.find((x) => x.file.endsWith("plugin-format.md"));
    expect(missing?.message).toContain('"skills"');
  });

  it("catches both directions for extension points and every plugin-format field", () => {
    const root = fixture("sync");
    const docs = join(root, AGENT_DOCS_DIR);
    const f = checkAgentDocs(root, { points, agentTemplateFields });
    const got = f.map((x) => `${x.rule} ${x.file.slice(docs.length + 1)} ${x.message}`);
    const has = (rule: string, file: string, needle: string) =>
      expect(got.some((g) => g.startsWith(`${rule} ${file} `) && g.includes(needle))).toBe(true);
    // in the code, not in the docs
    has("agent-docs-missing", "plugin-format.md", 'plugin.v1 field "version"');
    has("agent-docs-missing", "extensions.md", 'extension point "alpha"');
    has("agent-docs-missing", "agent-templates.md", 'agent template field "tools"');
    has(
      "agent-docs-missing",
      "connector-templates.md",
      'connector-template.v1 field "displayName"',
    );
    // in the docs, gone from the code: generated rows
    has("agent-docs-orphan", "plugin-format.md", '"ghost"');
    has("agent-docs-orphan", "extensions.md", '"zeta"');
    has("agent-docs-orphan", "agent-templates.md", '"retired"');
    has("agent-docs-orphan", "connector-templates.md", '"old"');
    // in the docs, gone from the code: hand-written table rows
    has("agent-docs-orphan", "plugin-format.md", '"phantom"');
    has("agent-docs-orphan", "extensions.md", '"omega"');
    has("agent-docs-orphan", "connector-templates.md", '"vanished" has a row');
    has("agent-docs-orphan", "agent-templates.md", '"bygone" has a row');
    expect(got.some((g) => g.includes('"template" has a row'))).toBe(false);
    expect(got.some((g) => g.includes('"name" has a row'))).toBe(false);
    expect(got.some((g) => g.includes('"alpha" has a row'))).toBe(false);
    // a title that does not say authoring
    has("agent-docs-missing", "skills.md", 'must start with "Authoring:"');
  });

  it("requires the setup usage topic, whose title need not say authoring", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-docs-"));
    try {
      cpSync(fixture("clean"), root, { recursive: true });
      rmSync(join(root, AGENT_DOCS_DIR, "setup.md"));
      const f = checkAgentDocs(root, { points, agentTemplateFields });
      expect(f.map((x) => [x.rule, x.file.slice(join(root, AGENT_DOCS_DIR).length + 1)])).toEqual([
        ["agent-docs-missing", "setup.md"],
      ]);
      expect(f[0]?.message).toContain('topic "setup" has no file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
