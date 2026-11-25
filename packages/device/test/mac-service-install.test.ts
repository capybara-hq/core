import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICE_SERVICE_INSTALL_SEAL } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DeviceOwnerCeiling } from "../src/exec/operation-types.js";
import { startMacOperationWorker } from "../src/exec/operation-worker.js";
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
        { ...spec, files: undefined },
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
