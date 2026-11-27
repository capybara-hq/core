import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_SERVICE_INSTALL_KEY_FILE,
  DEVICE_SERVICE_INSTALL_SEAL,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DeviceOwnerCeiling } from "../src/exec/operation-types.js";
import { startMacOperationWorker } from "../src/exec/operation-worker.js";
import { InstallCache } from "../src/services/install-cache.js";
import { macServiceLauncher } from "../src/services/mac-launcher.js";
import { ServiceSupervisor } from "../src/services/supervisor.js";
import { removeTempParent, testDeviceId } from "./mac-temp-parent.js";
import { sealWorkspaceRuntime } from "./runtime-seal.js";

// The install directory under real Seatbelt (capybara-hq/plugins#209): a service writes it while it
// is unsealed, and from the start after its seal on it cannot write there, nor remove the seal.

const DEVICE_ID = testDeviceId("mac-service-install");
const darwin = process.platform === "darwin";
const workspace = { runtimeHash: "", cleanup: async () => {} };
let root = "";

beforeAll(async () => {
  if (!darwin) return;
  Object.assign(workspace, await sealWorkspaceRuntime());
  root = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-install-")));
});
afterAll(async () => {
  if (!darwin) return;
  await removeTempParent(DEVICE_ID);
  await workspace.cleanup();
  if (root !== "") await rm(root, { recursive: true, force: true });
});

/** Tries to write into its install directory and remove the seal, records both, then listens. */
const SERVICE = `import { writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
const dir = process.env.CAPYBARA_SERVICE_INSTALL;
const tryIt = (f) => { try { f(); return "ok"; } catch (e) { return e.code ?? String(e); } };
const result = {
  write: tryIt(() => writeFileSync(join(dir, "browser"), "replaced")),
  unseal: tryIt(() => rmSync(join(dir, ".sealed"))),
};
writeFileSync(join(process.env.CAPYBARA_SERVICE_STATE, "result.json"), JSON.stringify(result));
createServer((c) => c.end()).listen(process.env.CAPYBARA_SERVICE_SOCKET);
`;

it.runIf(darwin)(
  "a sealed install directory is read only for the service under real Seatbelt",
  async () => {
    const deviceDir = join(root, "d");
    const ws = join(deviceDir, "workspace");
    await mkdir(ws, { recursive: true });
    const workerState = join(root, "w");
    await mkdir(workerState, { mode: 0o700 });
    const ceiling = {
      revision: "r",
      outsideSandbox: false,
      network: "allowlist",
      allowedDomains: [],
      roots: { workspace: ws, skills: "/nonexistent/skills", tmp: "/nonexistent/tmp" },
      projectReach: "workspace",
      projectPaths: [],
      secretAndStateDenies: [],
      otherConnectionDenies: [],
      unreadableConnections: [],
      mountReexposedDenies: [],
      mountReexposureProblem: null,
      restrictedDeniedReadRoots: [],
      preparation: { skillsRoot: "/nonexistent/skills", attachmentsBase: "/nonexistent/a" },
    } as unknown as DeviceOwnerCeiling;
    const launcher = macServiceLauncher({
      deviceId: DEVICE_ID,
      stateDir: workerState,
      pythonPath: "/usr/bin/python3",
      runtimeHash: () => workspace.runtimeHash,
      readOwnerCeiling: async () => ceiling,
      startWorker: (request, signal) => startMacOperationWorker(request, signal),
    });
    const supervisor = new ServiceSupervisor({
      deviceDir,
      workspace: ws,
      launcher: () => launcher,
      socketAliasRoot: join(root, "a"),
    });
    const id = "browser.browser";
    const spec = {
      name: id,
      entry: "main.mjs",
      args: [],
      files: { "main.mjs": new TextEncoder().encode(SERVICE) },
    };
    const installDir = join(deviceDir, "svc-install", id);
    const stateDir = join(deviceDir, "svc", id);
    const result = async () =>
      JSON.parse(await readFile(join(stateDir, "result.json"), "utf8")) as Record<string, string>;
    try {
      // unsealed: the service writes its install directory
      await supervisor.ensure(spec, undefined, AbortSignal.timeout(60_000), { filesDigest: "d1" });
      expect(await result()).toMatchObject({ write: "ok" });
      // what it does once installed: seal (this test plays that part), then exit
      await writeFile(join(installDir, DEVICE_SERVICE_INSTALL_SEAL), "");
      await supervisor.stop(id, AbortSignal.timeout(30_000));
      // sealed: neither the install nor the seal can be changed by the service any more
      await supervisor.ensure(
        { name: spec.name, entry: spec.entry, args: spec.args },
        undefined,
        AbortSignal.timeout(60_000),
        {
          filesDigest: "d1",
        },
      );
      const sealed = await result();
      expect(sealed.write).not.toBe("ok");
      expect(sealed.unseal).not.toBe("ok");
      expect(await readFile(join(installDir, "browser"), "utf8")).toBe("replaced");
    } finally {
      await supervisor.stopAll(AbortSignal.timeout(30_000));
    }
  },
);

/**
 * Under the machine-wide cache (plugins#311): installs and seals its staging directory when
 * SEAL_IT is set, tries to write beside it in the cache, and records what it could do.
 */
const CACHED_SERVICE = `import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
const dir = process.env.CAPYBARA_SERVICE_INSTALL;
const tryIt = (f) => { try { const v = f(); return typeof v === "string" ? v : "ok"; } catch (e) { return e.code ?? String(e); } };
const result = {
  dir,
  write: tryIt(() => writeFileSync(join(dir, "browser"), "chromium")),
  beside: tryIt(() => writeFileSync(join(dir, "..", "..", "planted"), "x")),
  read: tryIt(() => readFileSync(join(dir, "browser"), "utf8")),
};
if (process.env.SEAL_IT === "1") result.seal = tryIt(() => writeFileSync(join(dir, ".sealed"), ""));
else result.unseal = tryIt(() => rmSync(join(dir, ".sealed")));
writeFileSync(join(process.env.CAPYBARA_SERVICE_STATE, "result.json"), JSON.stringify(result));
createServer((c) => c.end()).listen(process.env.CAPYBARA_SERVICE_SOCKET);
`;

it.runIf(darwin)(
  "under real Seatbelt the cache's staging is writable and its published entry read only",
  async () => {
    const deviceDir = join(root, "dc");
    const ws = join(deviceDir, "workspace");
    await mkdir(ws, { recursive: true });
    const workerState = join(root, "wc");
    await mkdir(workerState, { mode: 0o700 });
    const ceiling = {
      revision: "r",
      outsideSandbox: false,
      network: "allowlist",
      allowedDomains: [],
      roots: { workspace: ws, skills: "/nonexistent/skills", tmp: "/nonexistent/tmp" },
      projectReach: "workspace",
      projectPaths: [],
      secretAndStateDenies: [],
      otherConnectionDenies: [],
      unreadableConnections: [],
      mountReexposedDenies: [],
      mountReexposureProblem: null,
      restrictedDeniedReadRoots: [],
      preparation: { skillsRoot: "/nonexistent/skills", attachmentsBase: "/nonexistent/a" },
    } as unknown as DeviceOwnerCeiling;
    const launcher = macServiceLauncher({
      deviceId: DEVICE_ID,
      stateDir: workerState,
      pythonPath: "/usr/bin/python3",
      runtimeHash: () => workspace.runtimeHash,
      readOwnerCeiling: async () => ceiling,
      startWorker: (request, signal) => startMacOperationWorker(request, signal),
    });
    const cacheRoot = join(root, "cache");
    const supervisor = new ServiceSupervisor({
      deviceDir,
      workspace: ws,
      launcher: () => launcher,
      socketAliasRoot: join(root, "ac"),
      installCache: new InstallCache({ root: cacheRoot, scope: "https://prod.example.com" }),
    });
    const id = "browser.browser";
    const files = (main: string) => ({
      "main.mjs": new TextEncoder().encode(`${CACHED_SERVICE}// ${main}`),
      [DEVICE_SERVICE_INSTALL_KEY_FILE]: new TextEncoder().encode("chromium-1255\n"),
    });
    const stateDir = join(deviceDir, "svc", id);
    const result = async () =>
      JSON.parse(await readFile(join(stateDir, "result.json"), "utf8")) as Record<string, string>;
    try {
      // unsealed: a private staging directory in the cache, writable; nothing beside it
      await supervisor.ensure(
        { name: id, entry: "main.mjs", args: [], files: files("v1"), env: { SEAL_IT: "1" } },
        undefined,
        AbortSignal.timeout(60_000),
        { filesDigest: "d1" },
      );
      const staged = await result();
      expect(staged.dir).toContain(`${cacheRoot}/`);
      expect(staged.dir).toContain("/staging/");
      expect(staged).toMatchObject({ write: "ok", seal: "ok", read: "chromium" });
      expect(staged.beside).not.toBe("ok");
      // it exits sealed: published
      await supervisor.stop(id, AbortSignal.timeout(30_000));
      // a plugin upgrade with the same key: the published entry, read only under the sandbox
      await supervisor.ensure(
        { name: id, entry: "main.mjs", args: [], files: files("v2") },
        undefined,
        AbortSignal.timeout(60_000),
        { filesDigest: "d2" },
      );
      const sealed = await result();
      expect(sealed.dir).toMatch(/\/entries\/chromium-1255@[0-9a-f]{12}$/);
      expect(sealed.read).toBe("chromium");
      expect(sealed.write).not.toBe("ok");
      expect(sealed.unseal).not.toBe("ok");
      expect(sealed.beside).not.toBe("ok");
      expect(await readFile(join(sealed.dir as string, "browser"), "utf8")).toBe("chromium");
    } finally {
      await supervisor.stopAll(AbortSignal.timeout(30_000));
    }
  },
);
