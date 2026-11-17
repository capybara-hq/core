import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { macRestrictedSelfCheck } from "../src/exec/mac-self-check.js";
import type { MacWorkerRequest } from "../src/exec/operation-worker.js";
import { sealWorkspaceRuntime } from "./runtime-seal.js";

// restricted workers launch only from a verified, sealed runtime closure (B-7)
const workspace = { runtimeHash: "", cleanup: async () => {} };
beforeAll(async () => {
  Object.assign(workspace, await sealWorkspaceRuntime());
});
afterAll(async () => {
  await workspace.cleanup();
});
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function stateDir() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "cap-self-check-")));
  dirs.push(dir);
  return dir;
}
const signal = () => AbortSignal.timeout(60_000);
const result = (exitCode: number) => ({
  stdout: "",
  stderr: "",
  exitCode,
  timedOut: false,
  truncated: false,
});

it.runIf(process.platform === "darwin")(
  "a real restricted worker on the sealed runtime passes, and leaves nothing behind",
  async () => {
    const dir = await stateDir();
    expect(
      await macRestrictedSelfCheck(
        { stateDir: dir, pythonPath: "/usr/bin/python3", runtimeHash: workspace.runtimeHash },
        signal(),
      ),
    ).toBeNull();
    // only the staged worker runtime stays; the scratch directories are gone
    expect((await readdir(dir)).filter((n) => n.startsWith("restricted-check-"))).toEqual([]);
  },
);

it.runIf(process.platform === "darwin")(
  "a runtime hash the binding did not attest fails the check with the reason",
  async () => {
    const dir = await stateDir();
    const reason = await macRestrictedSelfCheck(
      { stateDir: dir, pythonPath: "/usr/bin/python3", runtimeHash: "0".repeat(64) },
      signal(),
    );
    expect(reason).toMatch(/self-check failed: .*attested/);
    expect((await readdir(dir)).filter((n) => n.startsWith("restricted-check-"))).toEqual([]);
  },
);

it("needs an attested runtime, and fails off macOS", async () => {
  const dir = await stateDir();
  expect(
    await macRestrictedSelfCheck({ stateDir: dir, pythonPath: "/usr/bin/python3" }, signal()),
  ).toMatch(/attested runtime/);
  expect(
    await macRestrictedSelfCheck(
      {
        stateDir: dir,
        pythonPath: "/usr/bin/python3",
        runtimeHash: "a".repeat(64),
        platform: "linux",
      },
      signal(),
    ),
  ).toMatch(/macOS/);
});

it("asks the worker for a restricted write inside its root and a refused one outside", async () => {
  const dir = await stateDir();
  const seen: MacWorkerRequest[] = [];
  const startWorker = (exitCode: number) => async (request: MacWorkerRequest) => {
    seen.push(request);
    await request.beforeLaunch();
    return {
      ready: Promise.resolve(),
      completion: Promise.resolve(result(exitCode)),
      cancel: async () => {},
    };
  };
  const input = {
    stateDir: dir,
    pythonPath: "/usr/bin/python3",
    runtimeHash: "a".repeat(64),
    platform: "darwin" as const,
  };
  expect(
    await macRestrictedSelfCheck({ ...input, startWorker: startWorker(0) }, signal()),
  ).toBeNull();
  const request = seen[0];
  if (request?.kind !== "exec") throw new Error("expected an exec request");
  expect(request.grant).toMatchObject({ full: false, hosts: [], readRoots: [] });
  expect(request.grant.writeRoots).toHaveLength(1);
  expect(request.runtimeHash).toBe("a".repeat(64));
  expect(request.args.command).toContain(request.grant.writeRoots[0]);
  // the denied write succeeded (or the allowed one failed): restricted execution does not hold
  expect(await macRestrictedSelfCheck({ ...input, startWorker: startWorker(3) }, signal())).toMatch(
    /does not hold/,
  );
  const throwing = async () => {
    throw new Error("no sealed runtime");
  };
  expect(await macRestrictedSelfCheck({ ...input, startWorker: throwing }, signal())).toMatch(
    /self-check failed: no sealed runtime/,
  );
  expect(await readdir(dir)).toEqual([]);
});
