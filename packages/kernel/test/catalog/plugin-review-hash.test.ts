import { describe, expect, it } from "vitest";
import { item } from "../../src/catalog/claude/report.js";
import { pluginReviewHash } from "../../src/catalog/plugin-import.js";

/**
 * The review digest covers the phase B fields on their own (review I1, M9): a change of only the
 * report, the license text, the format or a review flag gives another hash, with the files and
 * their content digest byte-identical.
 */

type HashInput = Parameters<typeof pluginReviewHash>[0];

const BASE: HashInput = {
  name: "solo",
  version: "1.0.0",
  contentDigest: "d".repeat(64),
  connectorTemplates: [],
  skills: [{ name: "one", path: "skills/one", files: 1 } as HashInput["skills"][number]],
  dependencies: [],
  format: "claude-code",
  translation: {
    format: "claude-code",
    manifestPath: ".claude-plugin/plugin.json",
    sessionStart: false,
    items: [item("skill_imported", "skill", "one", { path: "skills/one" })],
  },
  licenseText: "MIT\n",
};
const FILES = [{ path: "skills/one/SKILL.md", sha256: "a".repeat(64) }];
const hash = (r: Partial<HashInput>) => pluginReviewHash({ ...BASE, ...r }, FILES);
const without = (k: "translation" | "licenseText"): HashInput => {
  const { [k]: _, ...rest } = BASE;
  return rest;
};

describe("pluginReviewHash", () => {
  it("is stable for the same input", () => {
    expect(hash({})).toBe(pluginReviewHash({ ...BASE }, [...FILES]));
    expect(hash({})).toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes with one more translation item, one changed detail, the license text and the format", () => {
    const base = hash({});
    const t = BASE.translation as NonNullable<HashInput["translation"]>;
    const hook = item("hooks_not_run", "hook", "Stop", { detail: { handlers: "command" } });
    const variants: Partial<HashInput>[] = [
      { translation: { ...t, items: [...t.items, hook] } },
      {
        translation: {
          ...t,
          items: [
            ...t.items,
            item("hooks_not_run", "hook", "Stop", { detail: { handlers: "prompt" } }),
          ],
        },
      },
      without("translation"),
      { licenseText: "Apache-2.0\n" },
      without("licenseText"),
      { format: "capybara" },
      { claudeManifestIgnored: true },
      { licenseTruncated: true },
    ];
    const seen = new Set([base]);
    for (const v of variants) {
      const h = "name" in v ? pluginReviewHash(v as HashInput, FILES) : hash(v);
      expect(h, JSON.stringify(v)).not.toBe(base);
      seen.add(h);
    }
    expect(seen.size).toBe(variants.length + 1);
  });

  it("covers agent templates (phase C) and leaves the digest of a plugin without any unchanged", () => {
    const base = hash({});
    expect(hash({ agentTemplates: [] })).toBe(base);
    const reviewer = {
      name: "reviewer",
      path: "agents/reviewer.md",
      description: "Reviews.",
      instructions: "Review.",
      model: "inherit" as const,
    };
    const one = hash({ agentTemplates: [reviewer] });
    expect(one).not.toBe(base);
    expect(hash({ agentTemplates: [{ ...reviewer, model: "fast" }] })).not.toBe(one);
    expect(hash({ agentTemplates: [{ ...reviewer, tools: ["sandbox_read"] }] })).not.toBe(one);
  });
});
