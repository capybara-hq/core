import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkKernelConventions,
  KC_ALLOWED_FACTORY_TOKENS,
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

/**
 * The `// expect: <rule>[, <rule>…]` markers of a fixture, as sorted `rule path:line` strings.
 */
function expected(root: string): string[] {
  const out: string[] = [];
  for (const file of filesUnder(root)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, i) => {
        const m = /\/\/ expect: (kc-[a-z-]+(?:, kc-[a-z-]+)*)/.exec(text);
        for (const rule of m?.[1]?.split(", ") ?? []) {
          out.push(`${rule} ${relative(root, file)}:${i + 1}`);
        }
      });
  }
  return out.sort();
}

/**
 * Runs the check on a fixture with no pending entries and only the exceptions whose file it has
 * (the factory allowances only on the kc-wiring fixture, which has their modules).
 */
function run(root: string, rule?: KcRule): string[] {
  const exceptions = KC_EXCEPTIONS.filter(
    (e) => (rule === undefined || e.rule === rule) && existsSync(join(root, e.path)),
  );
  const factoryTokens = rule === "kc-wiring" ? KC_ALLOWED_FACTORY_TOKENS : [];
  return checkKernelConventions(root, { pending: {}, exceptions, factoryTokens })
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

  // kc-queue fixture: 4 violations under packages/kernel/src/runtime/.
  const queueRoot = join(fixtures, "kc-queue");
  const ratchet = (max: number, extra: { path: string; max: number }[] = []) =>
    checkKernelConventions(queueRoot, {
      pending: { "kc-queue": [{ path: "packages/kernel/src/runtime/", max }, ...extra] },
      exceptions: [],
      factoryTokens: [],
    }).map((x) => [x.rule, relative(queueRoot, x.file), x.line, x.message]);

  it("a pending entry hides exactly max violations under it", () => {
    expect(ratchet(4)).toEqual([]);
  });

  it("more violations than max under a pending entry are all reported (the ratchet)", () => {
    const f = ratchet(3);
    expect(f.map((x) => x[0])).toEqual(["kc-queue", "kc-queue", "kc-queue", "kc-queue"]);
    expect(f[0]?.[3]).toContain(
      'pending "packages/kernel/src/runtime/" allows 3 kc-queue, found 4',
    );
  });

  it("fewer violations than max fail as stale: lower max", () => {
    const f = ratchet(6);
    expect(f.map((x) => [x[0], x[1]])).toEqual([
      ["kc-stale-pending", "packages/kernel/src/runtime"],
    ]);
    expect(f[0]?.[3]).toContain('lower max for "packages/kernel/src/runtime/" to 4');
  });

  it("a pending entry with no violation left fails (the list only shrinks)", () => {
    const f = ratchet(4, [{ path: "packages/kernel/src/agents/", max: 1 }]);
    expect(f.map((x) => [x[0], x[1]])).toEqual([
      ["kc-stale-pending", "packages/kernel/src/agents"],
    ]);
    expect(f[0]?.[3]).toContain(
      'no kc-queue violation left here: remove "packages/kernel/src/agents/"',
    );
  });

  it("an exception hides only its own file (and function), and a stale one fails", () => {
    const root = join(fixtures, "kc-process");
    const reason = "test";
    const f = checkKernelConventions(root, {
      pending: {},
      factoryTokens: [],
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
          within: "startBuiltKernelApp",
          reason,
        },
        { rule: "kc-process", path: "packages/kernel/src/gone.ts", reason },
      ],
    });
    expect(f.map((x) => [x.rule, relative(root, x.file)])).toEqual([
      ["kc-stale-exception", "packages/kernel/src/gone.ts"],
    ]);
  });

  it("a factory allowance covers only its own module, and one that matches nothing fails", () => {
    const root = join(fixtures, "kc-wiring");
    const reason = "test";
    const f = checkKernelConventions(root, {
      pending: {},
      exceptions: [],
      factoryTokens: [
        ...KC_ALLOWED_FACTORY_TOKENS,
        { token: "GONE_QUOTA", path: "packages/kernel/src/runtime/runtime.module.ts", reason },
      ],
    })
      .filter((x) => x.rule === "kc-stale-exception")
      .map((x) => [x.rule, relative(root, x.file), x.message]);
    expect(f).toEqual([
      [
        "kc-stale-exception",
        "packages/kernel/src/runtime/runtime.module.ts",
        expect.stringContaining("the factory allowance for GONE_QUOTA matches no"),
      ],
    ]);
  });

  it("every pending and exception path exists in the repository", () => {
    const paths = [
      ...Object.values(KC_PENDING)
        .flat()
        .map((p) => p?.path),
      ...KC_EXCEPTIONS.map((e) => e.path),
      ...KC_ALLOWED_FACTORY_TOKENS.map((a) => a.path),
    ] as string[];
    expect(paths.filter((p) => !existsSync(join(repoRoot, p)))).toEqual([]);
    for (const e of [...KC_EXCEPTIONS, ...KC_ALLOWED_FACTORY_TOKENS]) {
      expect(e.reason.length).toBeGreaterThan(20);
    }
  });
});
