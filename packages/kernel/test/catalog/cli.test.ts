import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCliObjectStore } from "../../src/catalog/cli.js";
import type { ExtensionCli } from "../../src/extensions/cli.js";
import { ExtensionHost } from "../../src/extensions/host.js";

const fixture = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const log = { warn() {} };

/** A CLI context over config-declared fixtures (no database): only what loadCliObjectStore reads. */
async function cliOf(
  plugins: string[],
  snapshots: string[] = [],
  autoApprove = false,
): Promise<Parameters<typeof loadCliObjectStore>[0]> {
  const inspected = await ExtensionHost.inspect(plugins);
  const approved = new Map(
    inspected
      .filter((p) => snapshots.includes(p.manifest.name))
      .map((p) => [
        p.manifest.name,
        {
          plugin: p.manifest.name,
          version: p.manifest.version,
          permissions: p.permissions,
          approvedBy: null,
          approvedAt: new Date(),
          source: "cli" as const,
        },
      ]),
  );
  return {
    inspected,
    deploymentConfigs: new Map(),
    configIssues: new Map(),
    approvals: { all: async () => approved } as unknown as ExtensionCli["approvals"],
    config: { extensionPermissions: { autoApprove } } as ExtensionCli["config"],
  };
}

describe("loadCliObjectStore", () => {
  it("refuses a config-declared object store whose permissions are not approved", async () => {
    const r = await loadCliObjectStore(await cliOf([fixture("mem-store")]), log);
    expect(r.store).toBeUndefined();
    expect(r).toMatchObject({ reason: "mem-store awaits permission approval" });
  });

  it("uses it once approved (snapshot or autoApprove)", async () => {
    expect(
      (await loadCliObjectStore(await cliOf([fixture("mem-store")], ["mem-store"]), log)).store,
    ).toBeDefined();
    expect(
      (await loadCliObjectStore(await cliOf([fixture("mem-store")], [], true), log)).store,
    ).toBeDefined();
  });

  it("says so when no object store is declared", async () => {
    const r = await loadCliObjectStore(await cliOf([fixture("perm-a")]), log);
    expect(r).toMatchObject({ reason: "no object-store extension is declared" });
  });
});
