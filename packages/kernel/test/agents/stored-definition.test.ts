import { describe, expect, it } from "vitest";
import { normalizeStoredDefinition } from "../../src/agents/definition.js";
import {
  deriveInstructions,
  joinInstructionFiles,
  readInstructionFiles,
} from "../../src/agents/instruction-files.js";

describe("a stored definition read back (normalizeStoredDefinition)", () => {
  const files = [
    { name: "AGENTS.md", content: "a" },
    { name: "B.md", content: "b" },
  ];
  const stored = {
    name: "Stored",
    instructions: joinInstructionFiles(files),
    instructionFiles: files,
    model: { provider: "model-fake", model: "fake-1" },
    disabledTools: [],
    toolPolicies: { Bash: "ask", mcp__tracker__find: "deny" },
  };

  it("keeps the prompt files, the joined instructions and the tool keys as stored", () => {
    const d = normalizeStoredDefinition(stored);
    expect(d.disabledTools).toEqual([]);
    expect(d.toolPolicies).toEqual({ Bash: "ask", mcp__tracker__find: "deny" });
    expect(d.instructionFiles).toEqual(files);
    expect(d.instructions).toBe(stored.instructions);
    expect(readInstructionFiles(d)).toEqual(files);
  });

  it("an invalid stored attribution mode reads as inherit, keeping the other fields", () => {
    // stored data is not re-validated: the kernel and the agent page both read it as inherit
    const bogus = normalizeStoredDefinition({
      ...stored,
      attribution: { mode: "bogus", commit: "Co-Authored-By: X" },
    });
    expect(bogus.attribution).toEqual({ mode: "inherit", commit: "Co-Authored-By: X" });
    // a valid mode is kept as it is
    for (const mode of ["inherit", "custom", "off"] as const) {
      const d = normalizeStoredDefinition({ ...stored, attribution: { mode } });
      expect(d.attribution).toEqual({ mode });
    }
  });

  it("a save re-sending the joined text over the current version keeps the files", () => {
    const current = normalizeStoredDefinition(stored);
    const saved = deriveInstructions(
      {
        name: "Stored",
        instructions: stored.instructions,
        model: { provider: "model-fake", model: "fake-1" },
      } as Parameters<typeof deriveInstructions>[0],
      current,
    );
    expect(saved.instructionFiles).toEqual(files);
    expect(saved.instructions).toBe(stored.instructions);
  });
});
