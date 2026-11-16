import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginChecks } from "@capybara-hq/plugin-tools";
import { describe, expect, it } from "vitest";
import { corePluginScope } from "../src/cli/dirs.js";
import { root } from "../src/cli/report.js";
import { RUNNERS } from "../src/cli/runners.js";
import { CHECKS, type CheckEntry } from "../src/registry.js";

interface World {
  scripts: Record<string, string>;
  readme: string;
  cliExists: (cli: string) => boolean;
  pluginNames: string[];
  runnerKeys: string[];
}

/** Every disagreement between the registry and the places that must name each check. */
function registryProblems(entries: readonly CheckEntry[], w: World): string[] {
  const out: string[] = [];
  const names = new Set<string>();
  for (const e of entries) {
    if (names.has(e.name)) out.push(`${e.name}: duplicate entry`);
    names.add(e.name);
    const script = w.scripts[`check:${e.name}`];
    if (script === undefined) out.push(`${e.name}: no check:${e.name} script in package.json`);
    else if (!script.includes(`tools/checks/src/cli/${e.cli}.ts`))
      out.push(`${e.name}: script does not run src/cli/${e.cli}.ts`);
    if (!w.cliExists(e.cli)) out.push(`${e.name}: src/cli/${e.cli}.ts is missing`);
    if (!w.readme.includes(`\`check:${e.name}\``)) out.push(`${e.name}: no README entry`);
    if (e.reason.trim() === "" || e.description.trim() === "") out.push(`${e.name}: empty text`);
    if (e.plugin !== undefined && !w.pluginNames.includes(e.plugin))
      out.push(`${e.name}: plugin-tools has no check named ${e.plugin}`);
    if (e.plugin !== undefined && !e.inAll) out.push(`${e.name}: plugin check not in pnpm check`);
    const needsRunner = e.inAll && e.plugin === undefined;
    if (needsRunner && !w.runnerKeys.includes(e.name)) out.push(`${e.name}: no runner`);
    if (!needsRunner && w.runnerKeys.includes(e.name)) out.push(`${e.name}: runner not used`);
  }
  for (const s of Object.keys(w.scripts))
    if (s.startsWith("check:") && !names.has(s.slice("check:".length)))
      out.push(`${s}: script is not in the registry`);
  for (const k of w.runnerKeys) if (!names.has(k)) out.push(`${k}: runner without entry`);
  return out;
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const real = (): World => ({
  scripts: pkg.scripts,
  readme: readFileSync(join(root, "tools/checks/README.md"), "utf8"),
  cliExists: (cli) => existsSync(join(root, "tools/checks/src/cli", `${cli}.ts`)),
  pluginNames: pluginChecks(corePluginScope()).map((c) => c.name),
  runnerKeys: Object.keys(RUNNERS),
});

describe("check registry", () => {
  it("agrees with package.json scripts, CLI files, README, plugin-tools and the runners", () => {
    expect(registryProblems(CHECKS, real())).toEqual([]);
  });

  it("a script missing from the registry is reported", () => {
    const w = real();
    w.scripts = { ...w.scripts, "check:brand-new": "tsx tools/checks/src/cli/x.ts" };
    expect(registryProblems(CHECKS, w)).toEqual(["check:brand-new: script is not in the registry"]);
  });

  it("an entry without script, README entry or runner is reported", () => {
    const extra: CheckEntry = {
      name: "ghost",
      cli: "ghost",
      ciMode: "full",
      reason: "r",
      description: "d",
      inAll: true,
    };
    expect(registryProblems([...CHECKS, extra], real())).toEqual([
      "ghost: no check:ghost script in package.json",
      "ghost: src/cli/ghost.ts is missing",
      "ghost: no README entry",
      "ghost: no runner",
    ]);
  });

  it("a README without the entry is reported", () => {
    const w = real();
    w.readme = w.readme.replaceAll("`check:config-docs`", "`x`");
    expect(registryProblems(CHECKS, w)).toEqual(["config-docs: no README entry"]);
  });

  it("every ciMode is full or diff, and diff checks take a base", () => {
    for (const e of CHECKS) {
      expect(["full", "diff"]).toContain(e.ciMode);
      if (e.ciMode === "diff") expect(e.inAll).toBe(false);
    }
  });
});
