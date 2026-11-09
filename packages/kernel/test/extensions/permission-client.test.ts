import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type ExtensionPermissions, staticManifestOf } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { afterAll, describe, expect, it } from "vitest";
import { permissionSetOfSection } from "../../src/extensions/package.js";
import {
  blockingKeys,
  buildPermissionSet,
  diffPermissions,
  type PermissionSet,
  permissionKeys,
} from "../../src/extensions/permission-set.js";
import {
  isSensitivePermissionKey,
  permissionGroups,
  permissionKeyItems,
} from "../../src/extensions/permission-view.js";
import clientA from "../fixtures/plugins/client-a/index.js";

const CLIENT_A = fileURLToPath(new URL("../fixtures/plugins/client-a/index.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const setOf = (permissions: ExtensionPermissions) =>
  buildPermissionSet({
    provides: [],
    config: { deployment: [], org: [] },
    tables: [],
    permissions,
  });

describe("client code and components in the permission set (client extensions spec §5.4)", () => {
  it("permissionKeys lists permissions.client and ui.component keys", () => {
    const set = setOf({ client: true, ui: { views: ["tasks"], components: ["hud", "brand"] } });
    expect(set.permissions.client).toBe(true);
    expect(set.permissions.ui.components).toEqual(["brand", "hud"]);
    expect(permissionKeys(set)).toEqual([
      "permissions.client",
      "ui.component:brand",
      "ui.component:hud",
      "ui.view:tasks",
    ]);
    // without client code: no key, and the flag is false
    const plain = setOf({ ui: { views: ["tasks"] } });
    expect(plain.permissions.client).toBe(false);
    expect(plain.permissions.ui.components).toEqual([]);
    expect(permissionKeys(plain)).toEqual(["ui.view:tasks"]);
  });

  it("both keys are sensitive", () => {
    expect(isSensitivePermissionKey("permissions.client")).toBe(true);
    expect(isSensitivePermissionKey("ui.component:hud")).toBe(true);
    expect(isSensitivePermissionKey("ui.view:hud")).toBe(false);
    expect(permissionKeyItems(["permissions.client", "ui.component:hud", "ui.view:x"])).toEqual([
      { value: "permissions.client", sensitive: true, reason: "client_code" },
      { value: "ui.component:hud", sensitive: true, reason: "ui_component" },
      { value: "ui.view:x", sensitive: false },
    ]);
  });

  it("the review groups show a sensitive client group and components in the UI group", () => {
    const groups = permissionGroups(
      setOf({ client: true, ui: { views: ["tasks"], components: ["hud"] } }),
    );
    expect(groups.find((g) => g.category === "client")).toEqual({
      category: "client",
      sensitive: true,
      items: ["client code"],
      entries: [{ value: "client code", sensitive: true, reason: "client_code" }],
    });
    expect(groups.find((g) => g.category === "ui")).toEqual({
      category: "ui",
      sensitive: true,
      items: ["view:tasks", "component:hud"],
      entries: [
        { value: "view:tasks", sensitive: false },
        { value: "component:hud", sensitive: true, reason: "ui_component" },
      ],
    });
  });

  it("an upgrade adding a component blocks loading", () => {
    const old = setOf({ client: true, ui: { components: ["brand"] } });
    const next = setOf({ client: true, ui: { components: ["brand", "hud"] } });
    const { added } = diffPermissions(old, next);
    expect(added).toEqual(["ui.component:hud"]);
    expect(blockingKeys(added)).toContain("ui.component:hud");
    // client code alone (a CSS-only client section) blocks too
    expect(blockingKeys(diffPermissions(setOf({}), setOf({ client: true })).added)).toEqual([
      "permissions.client",
    ]);
  });

  it("a bundle-only upgrade adds no key", () => {
    // the client bundle's bytes (its sha) are not part of the manifest: the keys, not the bytes,
    // are reviewed
    const manifest = staticManifestOf(clientA);
    const a = permissionSetOfSection(
      { manifest, client: { sha256: "a".repeat(64) } } as Parameters<
        typeof permissionSetOfSection
      >[0],
      [],
    );
    const b = permissionSetOfSection(
      { manifest, client: { sha256: "b".repeat(64) } } as Parameters<
        typeof permissionSetOfSection
      >[0],
      [],
    );
    expect(permissionKeys(a)).toContain("permissions.client");
    expect(diffPermissions(a, b)).toEqual({ added: [], removed: [] });
  });

  it("an old snapshot without client fields parses as no client", () => {
    // a snapshot written before client code existed: no `client`, `ui` without `components`
    const old = {
      provides: [],
      requires: [],
      optional: [],
      config: { deployment: [], org: [] },
      tables: [],
      permissions: {
        secrets: false,
        storage: false,
        http: [],
        tools: [],
        hooks: [],
        models: [],
        network: [],
        ui: { views: ["tasks"], embeds: [] },
      },
    } as unknown as PermissionSet;
    expect(permissionKeys(old)).toEqual(["ui.view:tasks"]);
    expect(permissionGroups(old).map((g) => g.category)).toEqual(["ui"]);
    const next = setOf({ client: true, ui: { views: ["tasks"], components: ["hud"] } });
    expect(diffPermissions(old, next).added).toEqual(["permissions.client", "ui.component:hud"]);
  });
});

describe("capybara extensions review", () => {
  let pg: TestContainer | undefined;
  afterAll(async () => {
    await pg?.stop();
  });

  it("capybara extensions review marks client keys (sensitive)", async () => {
    pg = await startTestPostgres();
    const review = await runCli(["extensions", "review"], pg.url, [CLIENT_A]);
    expect(review.code, review.stderr).toBe(0);
    const lines = review.stdout.split("\n");
    expect(review.stdout).toContain("client-a 0.1.0: awaiting approval (new extension)");
    expect(lines).toContain("  + permissions.client  (sensitive)");
    expect(lines).toContain("  + ui.component:hud  (sensitive)");
  }, 180_000);
});

/** Runs `pnpm capybara <args>` as a child process against `dbUrl` (Redis unreachable: not used). */
function runCli(
  args: string[],
  dbUrl: string,
  plugins: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CAPYBARA_")) env[k] = v;
  Object.assign(env, {
    CAPYBARA_DB__URL: dbUrl,
    CAPYBARA_REDIS__URL: "redis://127.0.0.1:1",
    CAPYBARA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    CAPYBARA_EXTENSIONS: JSON.stringify(plugins),
  });
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--silent", "capybara", ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
