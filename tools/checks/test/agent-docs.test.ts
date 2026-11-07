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
});
const points = { alpha: point("Alpha does a thing.") };

describe("checkAgentDocs", () => {
  it("passes when every generated section matches and every topic exists", () => {
    expect(checkAgentDocs(fixture("clean"), { points })).toEqual([]);
  });

  it("reports a hand-edited section, a missing topic or field, and an orphan topic", () => {
    const root = fixture("violations");
    const docs = join(root, AGENT_DOCS_DIR);
    const f = checkAgentDocs(root, { points: { ...points, gamma: point("Gamma.") } });
    expect(f.map((x) => [x.rule, x.file.slice(docs.length + 1)]).sort()).toEqual(
      [
        ["agent-docs-stale", "extensions.md"],
        ["agent-docs-missing", "plugin-format.md"],
        ["agent-docs-missing", "extension-points/gamma.md"],
        ["agent-docs-orphan", "extension-points/beta.md"],
      ].sort(),
    );
    const missing = f.find((x) => x.file.endsWith("plugin-format.md"));
    expect(missing?.message).toContain('"skills"');
  });
});
