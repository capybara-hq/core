import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createRestrictedProof, macRestrictedSelfCheck } from "../src/exec/mac-self-check.js";
import { type MacWorkerRequest, startMacOperationWorker } from "../src/exec/operation-worker.js";
import { privateTempParentName } from "../src/exec/read-model.js";
import { macUserTempDir } from "../src/exec/shared.js";
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
    const deviceIds: string[] = [];
    const recording = async (request: MacWorkerRequest, s: AbortSignal) => {
      if (request.kind === "exec") deviceIds.push(request.scope.deviceId);
      return startMacOperationWorker(request, s);
    };
    expect(
      await macRestrictedSelfCheck(
        {
          stateDir: dir,
          pythonPath: "/usr/bin/python3",
          runtimeHash: workspace.runtimeHash,
          startWorker: recording,
        },
        signal(),
      ),
    ).toBeNull();
    // the private temp parent of the check's own device id is gone too
    expect(deviceIds.length).toBeGreaterThan(0);
    const userTemp = macUserTempDir() ?? (await realpath(tmpdir()));
    for (const id of new Set(deviceIds))
      expect(existsSync(join(userTemp, privateTempParentName(id))), id).toBe(false);
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

// A real worker whose read scope is wider than its grant (here: the directories of the check's
// ungranted files granted for reading, as an over-broad ancestor rule once did) fails the check.
it.runIf(process.platform === "darwin")(
  "a real restricted worker that can read an ungranted file fails the check",
  async () => {
    const dir = await stateDir();
    const widened = async (request: MacWorkerRequest, s: AbortSignal) => {
      if (request.kind !== "exec") throw new Error("expected exec");
      const paths = [
        ...request.args.command.matchAll(/if cat '([^']+)' >\/dev\/null 2>&1; then exit 6/g),
      ].map((m) => dirname(m[1] as string));
      return startMacOperationWorker(
        { ...request, grant: { ...request.grant, readRoots: paths } },
        s,
      );
    };
    expect(
      await macRestrictedSelfCheck(
        {
          stateDir: dir,
          pythonPath: "/usr/bin/python3",
          runtimeHash: workspace.runtimeHash,
          startWorker: widened,
        },
        signal(),
      ),
    ).toMatch(/read of an ungranted file went through/);
  },
);

// A read probe passes only when its `cat` is refused: a `cat` that fails for every file (here a
// shell function shadowing it) would pass every probe, so a granted file must read first.
it.runIf(process.platform === "darwin")(
  "a worker whose reads fail for every file fails the check (positive control)",
  async () => {
    const dir = await stateDir();
    const broken = async (request: MacWorkerRequest, s: AbortSignal) => {
      if (request.kind !== "exec") throw new Error("expected exec");
      return startMacOperationWorker(
        {
          ...request,
          args: { ...request.args, command: `cat() { return 1; }; ${request.args.command}` },
        },
        s,
      );
    };
    expect(
      await macRestrictedSelfCheck(
        {
          stateDir: dir,
          pythonPath: "/usr/bin/python3",
          runtimeHash: workspace.runtimeHash,
          startWorker: broken,
        },
        signal(),
      ),
    ).toMatch(/read of a granted file failed/);
  },
);

// The machine-reach probe: a grant reading the whole machine (`readRoots: ["/"]`) must read an
// unrelated file (its positive control) and still be refused the denied root.
it.runIf(process.platform === "darwin")(
  "a real machine-reach worker that cannot read an unrelated file fails the check (positive control)",
  async () => {
    const dir = await stateDir();
    const narrowed = async (request: MacWorkerRequest, s: AbortSignal) =>
      startMacOperationWorker(
        request.grant.readRoots.includes("/")
          ? { ...request, grant: { ...request.grant, readRoots: request.grant.writeRoots } }
          : request,
        s,
      );
    expect(
      await macRestrictedSelfCheck(
        {
          stateDir: dir,
          pythonPath: "/usr/bin/python3",
          runtimeHash: workspace.runtimeHash,
          startWorker: narrowed,
        },
        signal(),
      ),
    ).toMatch(/machine reach could not read an unrelated file/);
  },
);

it.runIf(process.platform === "darwin")(
  "a real machine-reach worker that reads the denied root fails the check",
  async () => {
    const dir = await stateDir();
    const undenied = async (request: MacWorkerRequest, s: AbortSignal) =>
      startMacOperationWorker(
        request.grant.readRoots.includes("/")
          ? { ...request, grant: { ...request.grant, deniedReadRoots: [] } }
          : request,
        s,
      );
    expect(
      await macRestrictedSelfCheck(
        {
          stateDir: dir,
          pythonPath: "/usr/bin/python3",
          runtimeHash: workspace.runtimeHash,
          startWorker: undenied,
        },
        signal(),
      ),
    ).toMatch(/machine reach read a denied path/);
  },
);

it("needs an attested runtime, and fails off macOS", async () => {
  const dir = await stateDir();
  expect(
    // on macOS (stated, so the attestation check is what answers on every host)
    await macRestrictedSelfCheck(
      { stateDir: dir, pythonPath: "/usr/bin/python3", platform: "darwin" },
      signal(),
    ),
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
  // a denied read root holding a file, and a TCP connection to a local listener
  expect(request.grant.deniedReadRoots).toHaveLength(1);
  expect(request.args.command).toContain(`${request.grant.deniedReadRoots[0]}/secret`);
  expect(request.args.command).toMatch(/\/dev\/tcp\/127\.0\.0\.1\/\d+/);
  // two ordinary files outside every granted and denied root: beside the root, and elsewhere
  const reads = [
    ...request.args.command.matchAll(/if cat '([^']+)' >\/dev\/null 2>&1; then exit 6/g),
  ];
  expect(reads).toHaveLength(2);
  for (const [, path] of reads) {
    expect(path?.startsWith(`${request.grant.writeRoots[0]}/`)).toBe(false);
    expect(path?.startsWith(`${request.grant.deniedReadRoots[0]}/`)).toBe(false);
  }
  // then the machine-reach probe: the whole machine minus the same denied root
  const machine = seen[1];
  if (machine?.kind !== "exec") throw new Error("expected a machine-reach exec request");
  expect(machine.grant).toMatchObject({ full: false, hosts: [], readRoots: ["/"] });
  expect(machine.grant.writeRoots).toEqual(request.grant.writeRoots);
  expect(machine.grant.deniedReadRoots).toEqual(request.grant.deniedReadRoots);
  expect(machine.args.command).toContain(`${request.grant.deniedReadRoots[0]}/secret`);
  const [, unrelated] =
    /if ! cat '([^']+)' >\/dev\/null 2>&1; then exit 8/.exec(machine.args.command) ?? [];
  expect(unrelated).toBe(reads[1]?.[1]);
  expect(seen).toHaveLength(2);
  // a machine-reach run that fails its positive control or reads the denied root
  const byReach = (first: number, second: number) => async (r: MacWorkerRequest) =>
    startWorker(r.grant.readRoots.includes("/") ? second : first)(r);
  expect(await macRestrictedSelfCheck({ ...input, startWorker: byReach(0, 8) }, signal())).toMatch(
    /machine reach could not read an unrelated file/,
  );
  expect(await macRestrictedSelfCheck({ ...input, startWorker: byReach(0, 9) }, signal())).toMatch(
    /machine reach read a denied path/,
  );
  expect(await macRestrictedSelfCheck({ ...input, startWorker: startWorker(6) }, signal())).toMatch(
    /read of an ungranted file went through/,
  );
  expect(await macRestrictedSelfCheck({ ...input, startWorker: startWorker(4) }, signal())).toMatch(
    /read of a denied path went through/,
  );
  expect(await macRestrictedSelfCheck({ ...input, startWorker: startWorker(5) }, signal())).toMatch(
    /network connection went through/,
  );
  // a worker that reaches the listener fails the check even when it exits 0
  const leaky = async (r: MacWorkerRequest) => {
    if (r.kind !== "exec") throw new Error("expected exec");
    const port = Number(/\/dev\/tcp\/127\.0\.0\.1\/(\d+)/.exec(r.args.command)?.[1]);
    await new Promise<void>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.end();
      });
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
    });
    return {
      ready: Promise.resolve(),
      completion: Promise.resolve(result(0)),
      cancel: async () => {},
    };
  };
  expect(await macRestrictedSelfCheck({ ...input, startWorker: leaky }, signal())).toMatch(
    /network connection went through/,
  );
  // a worker that never ends is bounded by the signal
  const stuck = async () => ({
    ready: Promise.resolve(),
    completion: new Promise<never>(() => {}),
    cancel: async () => {},
  });
  expect(
    await macRestrictedSelfCheck({ ...input, startWorker: stuck }, AbortSignal.timeout(50)),
  ).toMatch(/ran out of time/);
  // the denied write succeeded (or the allowed one failed): restricted execution does not hold
  expect(await macRestrictedSelfCheck({ ...input, startWorker: startWorker(3) }, signal())).toMatch(
    /write outside the write root went through/,
  );
  const throwing = async () => {
    throw new Error("no sealed runtime");
  };
  expect(await macRestrictedSelfCheck({ ...input, startWorker: throwing }, signal())).toMatch(
    /self-check failed: no sealed runtime/,
  );
  expect(await readdir(dir)).toEqual([]);
});

it("a failed proof is retried on the next report after its interval, not disabled for good", async () => {
  let clock = 0;
  const outcomes: (string | null)[] = ["busy machine", null];
  const proof = createRestrictedProof(async () => outcomes.shift() ?? null, {
    timeoutMs: 1000,
    retryMs: 100,
    now: () => clock,
  });
  expect(proof.failure()).toMatch(/not been checked/);
  await proof.attempt();
  expect(proof.failure()).toBe("busy machine");
  // within the interval a report does not run it again
  await proof.refresh();
  expect(proof.failure()).toBe("busy machine");
  clock = 150;
  await proof.refresh();
  expect(proof.failure()).toBeNull();
  // a held proof is never checked again
  await proof.refresh();
  expect(outcomes).toEqual([]);
});
