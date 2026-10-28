import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkKernelConventions,
  KC_EXCEPTIONS,
  KC_PENDING,
  KC_RULES,
  type KcRule,
} from "../src/kernel-conventions.js";

const fixtures = fileURLToPath(new URL("../fixtures/kernel-conventions", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/** The `// expect: <rule>` markers of a fixture, as sorted `rule path:line` strings. */
function expected(root: string): string[] {
  const out: string[] = [];
  for (const file of filesUnder(root)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, i) => {
        const m = /\/\/ expect: (kc-[a-z-]+)/.exec(text);
        if (m) out.push(`${m[1]} ${relative(root, file)}:${i + 1}`);
      });
  }
  return out.sort();
}

/** Runs the check on a fixture with no pending entries and only the exceptions whose file it has. */
function run(root: string, rule?: KcRule): string[] {
  const exceptions = KC_EXCEPTIONS.filter(
    (e) => (rule === undefined || e.rule === rule) && existsSync(join(root, e.path)),
  );
  return checkKernelConventions(root, { pending: {}, exceptions })
    .map((f) => `${f.rule} ${relative(root, f.file)}:${f.line}`)
    .sort();
}

describe("checkKernelConventions", () => {
  it("passes a tree that follows every convention", () => {
    expect(run(join(fixtures, "clean"))).toEqual([]);
  });

  for (const rule of KC_RULES) {
    it(`${rule}: reports exactly the marked lines of its fixture`, () => {
      const root = join(fixtures, rule);
      const want = expected(root);
      expect(want.length).toBeGreaterThan(0);
      expect(run(root, rule)).toEqual(want);
    });
  }

  it("a pending entry hides the violations under it", () => {
    const root = join(fixtures, "kc-queue");
    const f = checkKernelConventions(root, {
      pending: { "kc-queue": ["packages/kernel/src/runtime/"] },
      exceptions: [],
    });
    expect(f).toEqual([]);
  });

  it("a pending entry that no longer violates fails (the list only shrinks)", () => {
    const root = join(fixtures, "kc-queue");
    const f = checkKernelConventions(root, {
      pending: { "kc-queue": ["packages/kernel/src/runtime/", "packages/kernel/src/agents/"] },
      exceptions: [],
    });
    expect(f.map((x) => [x.rule, relative(root, x.file)])).toEqual([
      ["kc-stale-pending", "packages/kernel/src/agents"],
    ]);
    expect(f[0]?.message).toContain("kc-queue");
  });

  it("an exception hides only its own file (and function), and a stale one fails", () => {
    const root = join(fixtures, "kc-process");
    const reason = "test";
    const f = checkKernelConventions(root, {
      pending: {},
      exceptions: [
        {
          rule: "kc-process",
          path: "packages/kernel/src/app.ts",
          within: "createKernelApp",
          reason,
        },
        {
          rule: "kc-process",
          path: "packages/kernel/src/app.ts",
          within: "startKernelApp",
          reason,
        },
        { rule: "kc-process", path: "packages/kernel/src/gone.ts", reason },
      ],
    });
    expect(f.map((x) => [x.rule, relative(root, x.file)])).toEqual([
      ["kc-stale-exception", "packages/kernel/src/gone.ts"],
    ]);
  });

  it("every pending and exception path exists in the repository", () => {
    const paths = [
      ...Object.values(KC_PENDING).flat(),
      ...KC_EXCEPTIONS.map((e) => e.path),
    ] as string[];
    expect(paths.filter((p) => !existsSync(join(repoRoot, p)))).toEqual([]);
    for (const e of KC_EXCEPTIONS) expect(e.reason.length).toBeGreaterThan(20);
  });
});
