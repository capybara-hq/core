import { join } from "node:path";
import { pluginChecks } from "@capybara-hq/plugin-tools";
import { describe, expect, it } from "vitest";
import { corePluginScope } from "../src/cli/dirs.js";
import { root } from "../src/cli/report.js";

const fixture = (name: string) => join(root, "tools/checks/fixtures", name);

async function boundary(deviceDirs: string[]) {
  const scope = { root, plugins: [], deviceDirs };
  const check = pluginChecks(scope).find((c) => c.name === "Dependency boundary");
  if (check === undefined) throw new Error("no Dependency boundary check");
  return check.run();
}

describe("check:deps for packages/device", () => {
  it("packages/device importing @capybara-hq/kernel fails check:deps", async () => {
    const findings = await boundary([fixture("device-deps")]);
    expect(findings.map((f) => [f.rule, f.file.replace(`${fixture("device-deps")}/`, "")])).toEqual(
      [
        ["device-imports-internal", "package.json"],
        ["device-imports-internal", "src/index.ts"],
      ],
    );
    expect(findings.every((f) => f.message.includes("@capybara-hq/kernel"))).toBe(true);
  });

  it("plugin-sdk and third-party packages pass", async () => {
    expect(await boundary([fixture("device-deps-clean")])).toEqual([]);
  });

  it("core's scope covers packages/device, and the real package is clean", async () => {
    const scope = corePluginScope();
    expect(scope.deviceDirs).toEqual([join(root, "packages/device")]);
    expect(await boundary(scope.deviceDirs ?? [])).toEqual([]);
  });
});
