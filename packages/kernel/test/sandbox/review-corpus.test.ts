import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type RuleOutcome, reviewRules } from "../../src/sandbox/review/index.js";

/**
 * The acceptance corpus (auto-mode spec §5.2, §10): the acceptance conversations' `Bash` commands
 * plus a hand-written bypass file, each line hand-labelled with the decision and the rule ids in
 * rule order. Adding or changing a rule updates the labels in the same commit.
 */

interface CorpusLine {
  command: string;
  workspace?: string;
  cwd?: string;
  mode?: "auto" | "sandbox";
  attended?: boolean;
  outcome: RuleOutcome;
  rules: string[];
}

const CORPUS_DIR = fileURLToPath(new URL("./review/corpus/", import.meta.url));
const WORKSPACE = "/home/dev/workspace";

const FILES = [
  "acceptance-2026-11-12.jsonl",
  "acceptance-2026-11-13.jsonl",
  "bypass.jsonl",
] as const;

function load(file: string): CorpusLine[] {
  const text = readFileSync(`${CORPUS_DIR}${file}`, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as CorpusLine;
      } catch (error) {
        throw new Error(`${file}:${index + 1}: invalid JSON (${String(error)})`);
      }
    });
}

describe("the review corpus", () => {
  it("has a bypass file of at least 200 labelled commands", () => {
    expect(load("bypass.jsonl").length).toBeGreaterThanOrEqual(200);
  });

  for (const file of FILES) {
    describe(file, () => {
      const lines = load(file);

      it("has labelled commands", () => {
        expect(lines.length).toBeGreaterThan(0);
      });

      it.each(lines.map((line, index) => ({ line, index })))(
        "line $index: $line.command",
        ({ line, index }) => {
          const result = reviewRules(line.command, {
            workspace: line.workspace ?? WORKSPACE,
            mode: line.mode ?? "auto",
            attended: line.attended ?? true,
            ...(line.cwd === undefined ? {} : { cwd: line.cwd }),
          });
          const actual = { outcome: result.outcome, rules: result.hits.map((hit) => hit.id) };
          expect(actual, `${file}:${index + 1}: ${line.command}`).toEqual({
            outcome: line.outcome,
            rules: line.rules,
          });
        },
      );
    });
  }
});
