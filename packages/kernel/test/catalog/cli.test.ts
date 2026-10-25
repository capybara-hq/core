import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCliObjectStore } from "../../src/catalog/cli.js";
import type { PermissionSnapshot } from "../../src/extensions/approvals.js";
import type { ExtensionCli } from "../../src/extensions/cli.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import type { DesiredExtension } from "../../src/extensions/installs.js";
import { permissionSetOfPackage, readExtensionPackage } from "../../src/extensions/package.js";
import { pluginTgz } from "../helpers/plugin-packages.js";

const fixture = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const log = { warn() {} };

let syncDir: string;
beforeAll(async () => {
  syncDir = await mkdtemp(join(tmpdir(), "kernel-cli-store-"));
});
afterAll(async () => {
  await rm(syncDir, { recursive: true, force: true });
});

/** An installed package (by sha256) the CLI context below can read. */
interface Installed {
  bytes: Uint8Array;
  desired: DesiredExtension;
}

/** An install record of a plugin whose extension provides object-store@1 (an empty store object). */
async function installedStore(
  name: string,
  extra: Record<string, unknown> = {},
): Promise<Installed> {
  const bytes = await pluginTgz({
    manifest: { name, version: "1.0.0" },
    extension: {
      manifest: { provides: ["object-store@1"], ...extra },
      entry: [
        'import { defineExtension } from "@capybara-hq/plugin-sdk";',
        `export default defineExtension({ name: ${JSON.stringify(name)}, version: "1.0.0", sdk: "^0.1.0", provides: ["object-store@1"], permissions: {}, setup(ctx) { ctx.provide("object-store@1", { kind: "fake" }); } });`,
      ].join("\n"),
    },
  });
  const pkg = await readExtensionPackage(bytes, {
    maxBytes: 16 * 1024 * 1024,
    hostSdkVersion: SDK_VERSION,
  });
  return {
    bytes,
    desired: {
      name,
      sha256: pkg.sha256,
      version: "1.0.0",
      source: "bootstrap",
      migratedSha: null,
      blobStore: "pg",
      section: pkg.section,
    },
  };
}

/** A CLI context over config-declared fixtures and install records (no database): only what loadCliObjectStore reads. */
async function cliOf(
  plugins: string[],
  snapshots: string[] = [],
  autoApprove = false,
  installed: Installed[] = [],
): Promise<Parameters<typeof loadCliObjectStore>[0]> {
  const inspected = await ExtensionHost.inspect(plugins);
  const packages = new Map(installed.map((i) => [i.desired.sha256, i.bytes]));
  const packageSet = async (sha256: string) =>
    permissionSetOfPackage(
      await readExtensionPackage(packages.get(sha256) as Uint8Array, {
        maxBytes: 16 * 1024 * 1024,
        hostSdkVersion: SDK_VERSION,
      }),
    );
  const approved = new Map<string, PermissionSnapshot>(
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
  for (const i of installed) {
    if (!snapshots.includes(i.desired.name)) continue;
    approved.set(i.desired.name, {
      plugin: i.desired.name,
      version: i.desired.version,
      permissions: await packageSet(i.desired.sha256),
      approvedBy: null,
      approvedAt: new Date(),
      source: "bootstrap",
    });
  }
  return {
    inspected,
    deploymentConfigs: new Map(),
    deploymentConfigOf: async () => ({ ok: true, value: {} }),
    configIssues: new Map(),
    approvals: { all: async () => approved } as unknown as ExtensionCli["approvals"],
    config: {
      extensionPermissions: { autoApprove },
      packages: { maxBytes: 16 * 1024 * 1024 },
    } as ExtensionCli["config"],
    installs: {
      desired: async () => installed.map((i) => i.desired),
    } as unknown as ExtensionCli["installs"],
    packageSet,
    readPackage: async (sha256) => packages.get(sha256) as Uint8Array,
  };
}

describe("loadCliObjectStore", () => {
  it("refuses a config-declared object store whose permissions are not approved", async () => {
    const r = await loadCliObjectStore(await cliOf([fixture("mem-store")]), log, syncDir);
    expect(r.store).toBeUndefined();
    expect(r).toMatchObject({ reason: "mem-store awaits permission approval" });
  });

  it("uses it once approved (snapshot or autoApprove)", async () => {
    expect(
      (await loadCliObjectStore(await cliOf([fixture("mem-store")], ["mem-store"]), log, syncDir))
        .store,
    ).toBeDefined();
    expect(
      (await loadCliObjectStore(await cliOf([fixture("mem-store")], [], true), log, syncDir)).store,
    ).toBeDefined();
  });

  it("says so when no object store is declared or installed", async () => {
    const r = await loadCliObjectStore(await cliOf([fixture("perm-a")]), log, syncDir);
    expect(r).toMatchObject({ reason: "no object-store extension is declared or installed" });
  });

  it("uses an enabled install record (a bootstrap plugin) once its permissions are approved", async () => {
    const s3 = await installedStore("store-inst");
    const pending = await loadCliObjectStore(await cliOf([], [], false, [s3]), log, syncDir);
    expect(pending).toMatchObject({ reason: "store-inst awaits permission approval" });
    const approved = await loadCliObjectStore(
      await cliOf([], ["store-inst"], false, [s3]),
      log,
      syncDir,
    );
    expect(approved.store).toEqual({ kind: "fake" });
    expect((await loadCliObjectStore(await cliOf([], [], true, [s3]), log, syncDir)).store).toEqual(
      { kind: "fake" },
    );
  });

  it("refuses an install record whose deployment config is invalid", async () => {
    const s3 = await installedStore("store-cfg");
    const cli = await cliOf([], ["store-cfg"], false, [s3]);
    cli.deploymentConfigOf = async () => ({
      ok: false,
      issues: [{ path: "bucket", message: "x" }],
    });
    expect(await loadCliObjectStore(cli, log, syncDir)).toMatchObject({
      reason: "store-cfg is not configured (pending deployment config)",
    });
  });

  it("a config-declared extension of the same name hides the install record", async () => {
    const shadow = await installedStore("mem-store");
    const r = await loadCliObjectStore(
      await cliOf([fixture("mem-store")], [], false, [shadow]),
      log,
      syncDir,
    );
    expect(r).toMatchObject({ reason: "mem-store awaits permission approval" });
  });
});
