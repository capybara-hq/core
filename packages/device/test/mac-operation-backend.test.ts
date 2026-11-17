import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createMacOperationBackend } from "../src/exec/mac-operation-backend.js";
import type { DeviceOwnerCeiling } from "../src/exec/operation-types.js";
import type { MacWorkerHandle } from "../src/exec/operation-worker.js";
import { sealWorkspaceRuntime } from "./runtime-seal.js";

// restricted workers launch only from a verified, sealed runtime closure (B-7)
let unseal: (() => Promise<void>) | undefined;
beforeAll(async () => {
  unseal = await sealWorkspaceRuntime();
});
afterAll(async () => {
  await unseal?.();
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const signal = new AbortController().signal;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "cap-backend-"));
  dirs.push(dir);
  const roots = {
    workspace: join(dir, "workspace"),
    skills: join(dir, "skills"),
    tmp: join(dir, "tmp"),
  };
  await Promise.all(Object.values(roots).map((root) => mkdir(root)));
  let ceilingReads = 0;
  let ceiling: DeviceOwnerCeiling = {
    revision: "one",
    fullAccess: true,
    roots,
    restrictedProjectReach: "os-user",
    restrictedAllowedDomains: ["a.example.com"],
    restrictedDeniedReadRoots: [],
    preparation: {
      skillsRoot: roots.skills,
      attachmentsBase: join(roots.workspace, "attachments"),
    },
    fullNetwork: "environment",
  };
  const launched: unknown[] = [];
  let beforeStart = async () => {};
  let hold = false;
  let tick: (() => Promise<void>) | undefined;
  let stoppedWatcher = 0;
  const cancellations: string[] = [];
  const finishes = new Map<string, () => void>();
  const backend = await createMacOperationBackend(
    {
      deviceId: "d",
      instanceGeneration: "g",
      stateDir: dir,
      roots,
      pythonPath: "/usr/bin/python3",
      readOwnerCeiling: async () => {
        ceilingReads++;
        return ceiling;
      },
    },
    {
      restrictedSupported: true,
      platform: "darwin",
      watch: (callback) => {
        tick = callback;
        return () => {
          stoppedWatcher++;
        };
      },
      startWorker: async (r) => {
        await beforeStart();
        await r.beforeLaunch();
        await r.onLaunch({ pid: 123, token: "owned" });
        launched.push(r);
        return {
          ready: Promise.resolve(),
          completion: hold
            ? new Promise((resolve) => {
                finishes.set(r.scope.operationId, () =>
                  resolve({
                    stdout: "",
                    stderr: "",
                    exitCode: 0,
                    timedOut: false,
                    truncated: false,
                  }),
                );
              })
            : Promise.resolve(
                r.kind === "native"
                  ? { size: 3, isDir: false }
                  : { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false },
              ),
          cancel: async () => {
            cancellations.push(r.scope.operationId);
            finishes.get(r.scope.operationId)?.();
          },
        };
      },
    },
  );
  const scope = {
    operationId: "op",
    admitBeforeMs: Date.now() + 60000,
    deviceId: "d",
    rootConversationId: "r",
    profileRevision: 0,
    ceilingRevision: "opaque",
    profile: "approve-for-me" as const,
    actor: { accountId: "a", conversationId: "r" },
    tag: "op",
    filesystem: {
      kind: "scoped" as const,
      readRoots: [join(dir, "project")],
      writeRoots: [roots.tmp],
    },
    network: { kind: "none" as const },
  };
  return {
    backend,
    roots,
    scope,
    launched,
    ceilingReads: () => ceilingReads,
    beforeStart: (fn: () => Promise<void>) => {
      beforeStart = fn;
    },
    hold: () => {
      hold = true;
    },
    tick: async () => {
      await tick?.();
    },
    cancellations,
    stoppedWatcher: () => stoppedWatcher,
    setCeiling: (c: Partial<DeviceOwnerCeiling>) => {
      ceiling = { ...ceiling, ...c };
    },
  };
}
it("first native read uses its explicit outside project without an earlier exec", async () => {
  const f = await fixture();
  const op = await f.backend.operation({ id: "d", roots: f.roots }, f.scope, signal);
  expect(f.launched).toHaveLength(0);
  expect(await op.stat(`${f.scope.filesystem.readRoots[0]}/file`, signal)).toEqual({
    size: 3,
    isDir: false,
  });
  expect(f.launched).toHaveLength(1);
});
it("re-reads ceilings at invocation and rejects restricted exec without private provenance", async () => {
  const f = await fixture();
  const op = await f.backend.operation({ id: "d" }, f.scope, signal);
  await expect(
    op.exec({ command: "true", timeoutMs: 1000, maxOutputBytes: 1000, signal }),
  ).rejects.toThrow(/authority/);
  f.setCeiling({ revision: "two", restrictedProjectReach: "workspace" });
  await expect(op.stat(`${f.scope.filesystem.readRoots[0]}/file`, signal)).rejects.toThrow(
    /ceiling/,
  );
  expect(f.launched).toHaveLength(0);
});
it("preparation cannot select the entire attachments base or arbitrary roots", async () => {
  const f = await fixture();
  await expect(
    f.backend
      .prepare(
        { id: "d" },
        {
          operationId: "prep",
          deviceId: "d",
          purpose: "attachments",
          writeRoots: [join(f.roots.workspace, "attachments")],
          tag: "prep",
        },
        signal,
      )
      .then((p) => p.stat(join(f.roots.workspace, "attachments"), signal)),
  ).rejects.toThrow(/preparation/);
});
it("rejects wrong device handles before creating a worker", async () => {
  const f = await fixture();
  await expect(f.backend.operation({ id: "other" }, f.scope, signal)).rejects.toThrow(/handle/);
  expect(f.launched).toHaveLength(0);
});

it.runIf(process.platform === "darwin")(
  "real Full preserves the OS environment while restricted exec excludes ambient secrets",
  async () => {
    const { startMacOperationWorker } = await import("../src/exec/operation-worker.js");
    const { mkdir, realpath } = await import("node:fs/promises");
    const root = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-exec-")));
    dirs.push(root);
    const stateDir = join(root, "state");
    const project = join(root, "project");
    await mkdir(stateDir, { mode: 0o700 });
    await mkdir(project);
    const prior = process.env.CAPYBARA_OWNED_TEST_SECRET;
    process.env.CAPYBARA_OWNED_TEST_SECRET = "synthetic-owned-value";
    const workers: MacWorkerHandle[] = [];
    try {
      for (const full of [true, false]) {
        const scope = {
          operationId: full ? "full" : "scoped",
          admitBeforeMs: Date.now() + 30000,
          deviceId: "fixture",
          rootConversationId: "r",
          profileRevision: 0,
          ceilingRevision: "fixture",
          profile: "full-access" as const,
          actor: { accountId: "a", conversationId: "r" },
          tag: "fixture",
          filesystem: { kind: "device" as const },
          network: { kind: "environment" as const },
        };
        const worker = await startMacOperationWorker(
          {
            kind: "exec",
            scope,
            args: {
              command: 'printf %s "$CAPYBARA_OWNED_TEST_SECRET"',
              cwd: project,
              timeoutMs: 5000,
              maxOutputBytes: 100,
            },
            grant: {
              full,
              readRoots: full ? ["/"] : [project],
              writeRoots: [],
              hosts: [],
              deniedReadRoots: [stateDir],
              revision: "fixture",
            },
            stateDir,
            pythonPath: "/usr/bin/python3",
            beforeLaunch: async () => {},
            onLaunch: async () => {},
          },
          AbortSignal.timeout(10000),
        );
        workers.push(worker);
        await worker.ready;
        const output = await worker.completion;
        expect(output).toMatchObject({ exitCode: 0, stdout: full ? "synthetic-owned-value" : "" });
      }
    } finally {
      if (prior === undefined) delete process.env.CAPYBARA_OWNED_TEST_SECRET;
      else process.env.CAPYBARA_OWNED_TEST_SECRET = prior;
      await Promise.all(workers.map((w) => w.cancel("fixture cleanup")));
    }
  },
);

it("rejects a revision change during trusted startup before effects", async () => {
  const f = await fixture();
  f.beforeStart(async () => {
    f.setCeiling({ revision: "changed-during-start" });
  });
  const op = await f.backend.operation({ id: "d" }, f.scope, signal);
  await expect(op.stat(`${f.scope.filesystem.readRoots[0]}/file`, signal)).rejects.toThrow(
    /changed before launch/,
  );
  expect(f.launched).toHaveLength(0);
});
it("owned idle watcher revokes removed baseline while preserving independent granted sibling", async () => {
  const f = await fixture();
  f.hold();
  const start = async (id: string, approved: boolean) => {
    const s = {
      ...f.scope,
      operationId: id,
      network: { kind: "allowlist" as const, hosts: ["a.example.com"] },
    };
    const authority = {
      operationId: id,
      orgNetwork: { kind: "open-public" as const, hosts: [] },
      ...(approved
        ? {
            grants: {
              hosts: ["a.example.com"],
              source: { kind: "task" as const, id: "task", accountId: "a" },
            },
          }
        : {}),
    };
    return f.backend.forExecution(authority).background.start({ id: "d" }, s, {
      command: "fixture command",
      timeoutMs: 10000,
      maxOutputBytes: 1000,
      taskId: id,
      outputPath: join(f.roots.tmp, id),
      retainUntilMs: Date.now() + 60000,
      signal,
    });
  };
  const removed = await start("baseline", false);
  const granted = await start("granted", true);
  f.setCeiling({ revision: "two", restrictedAllowedDomains: [] });
  await f.tick();
  expect(f.cancellations).toEqual(["baseline"]);
  expect(await f.backend.background.status({ id: "d" }, granted, signal)).toEqual({
    state: "running",
  });
  expect(await f.backend.background.stop({ id: "d" }, removed, { graceMs: 0, signal })).toEqual({
    outcome: "stopped",
  });
  await f.backend.background.stop({ id: "d" }, granted, { graceMs: 0, signal });
  expect(f.stoppedWatcher()).toBe(1);
});
it("Full owner narrowing cancels Full without a websocket or another tool call", async () => {
  const f = await fixture();
  f.hold();
  const full = {
    ...f.scope,
    filesystem: { kind: "device" as const },
    network: { kind: "environment" as const },
  };
  const ref = await f.backend.background.start({ id: "d" }, full, {
    command: "owned full fixture",
    timeoutMs: 10000,
    maxOutputBytes: 1000,
    taskId: "task",
    outputPath: join(f.roots.tmp, "out"),
    retainUntilMs: Date.now() + 60000,
    signal,
  });
  f.setCeiling({ revision: "two", fullAccess: false });
  await f.tick();
  expect(f.cancellations).toEqual(["op"]);
  expect(await f.backend.background.stop({ id: "d" }, ref, { graceMs: 0, signal })).toEqual({
    outcome: "stopped",
  });
});

it.runIf(process.platform === "darwin")(
  "overlapping real immutable workers retain their separate network grants",
  async () => {
    const { createServer } = await import("node:http");
    const { mkdir, realpath } = await import("node:fs/promises");
    const { startMacOperationWorker } = await import("../src/exec/operation-worker.js");
    const root = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-network-")));
    dirs.push(root);
    const stateDir = join(root, "state");
    const project = join(root, "project");
    await mkdir(stateDir, { mode: 0o700 });
    await mkdir(project);
    let received!: () => void;
    const firstReceived = new Promise<void>((r) => {
      received = r;
    });
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const receipts: string[] = [];
    const server = createServer(async (req, res) => {
      receipts.push(req.url ?? "");
      received();
      await hold;
      res.end("owned-response");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing owned port");
    const port = address.port;
    const workers: MacWorkerHandle[] = [];
    const scope = {
      operationId: "network-fixture",
      admitBeforeMs: Date.now() + 30000,
      deviceId: "owned-fixture",
      rootConversationId: "r",
      profileRevision: 0,
      ceilingRevision: "fixture",
      profile: "approve-for-me" as const,
      actor: { accountId: "a", conversationId: "r" },
      tag: "fixture",
      filesystem: { kind: "scoped" as const, readRoots: [project], writeRoots: [] },
      network: { kind: "none" as const },
    };
    const start = async (hosts: string[], token: string) => {
      const worker = await startMacOperationWorker(
        {
          kind: "exec",
          scope,
          args: {
            command: `/usr/bin/curl --fail --silent --show-error --max-time 5 --noproxy '' http://127.0.0.1:${port}/${token}`,
            cwd: project,
            timeoutMs: 8000,
            maxOutputBytes: 1000,
          },
          grant: {
            full: false,
            readRoots: [project],
            writeRoots: [],
            hosts,
            deniedReadRoots: [stateDir],
            revision: "fixture",
          },
          stateDir,
          pythonPath: "/usr/bin/python3",
          beforeLaunch: async () => {},
          onLaunch: async () => {},
        },
        AbortSignal.timeout(10000),
      );
      workers.push(worker);
      await worker.ready;
      return worker;
    };
    try {
      const allowed = await start([`127.0.0.1:${port}`], "allowed");
      await Promise.race([
        firstReceived,
        allowed.completion.then(() => {
          throw Error("Allowed worker exited before reaching its endpoint");
        }),
      ]);
      const denied = await start([], "denied");
      expect(await denied.completion).toMatchObject({ exitCode: 22 });
      expect(receipts).toEqual(["/allowed"]);
      release();
      expect(await allowed.completion).toMatchObject({ exitCode: 0, stdout: "owned-response" });
    } finally {
      release();
      await Promise.all(workers.map((w) => w.cancel("fixture cleanup")));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  },
);

it.runIf(process.platform === "darwin")(
  "real peer proxy borrowing fails in both initialization orders with exact worker cleanup",
  async () => {
    const { createServer, request: httpRequest } = await import("node:http");
    const { mkdir, realpath, writeFile } = await import("node:fs/promises");
    const { startMacOperationWorker } = await import("../src/exec/operation-worker.js");
    const root = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-peer-")));
    dirs.push(root);
    const stateDir = join(root, "state");
    const project = join(root, "project");
    await mkdir(stateDir, { mode: 0o700 });
    await mkdir(project);
    const servers: import("node:http").Server[] = [];
    const endpoints: { port: number; receipts: string[] }[] = [];
    for (let i = 0; i < 2; i++) {
      const receipts: string[] = [];
      const server = createServer((req, res) => {
        receipts.push(req.url ?? "");
        res.end("owned");
      });
      servers.push(server);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw Error("Missing owned endpoint");
      endpoints.push({ port: addr.port, receipts });
    }
    const workers: MacWorkerHandle[] = [];
    const identities: number[] = [];
    try {
      for (const order of [
        [0, 1],
        [1, 0],
      ]) {
        const urls = new Map<number, string>();
        let gateResolve!: () => void;
        const gate = new Promise<void>((r) => {
          gateResolve = r;
        });
        const initialized = new Map<number, () => void>();
        const phases = [0, 1].map(
          (i) =>
            new Promise<void>((r) => {
              initialized.set(i, r);
            }),
        );
        const pair: MacWorkerHandle[] = [];
        const start = async (i: number) => {
          const own = endpoints[i] as { port: number; receipts: string[] };
          const peer = endpoints[1 - i] as { port: number; receipts: string[] };
          const token = `order${order[0]}-worker${i}`;
          const scope = {
            operationId: token,
            admitBeforeMs: Date.now() + 30000,
            deviceId: "fixture",
            rootConversationId: "r",
            profileRevision: 0,
            ceilingRevision: "fixture",
            profile: "approve-for-me" as const,
            actor: { accountId: "a", conversationId: "r" },
            tag: token,
            filesystem: { kind: "scoped" as const, readRoots: [project], writeRoots: [] },
            network: { kind: "none" as const },
          };
          const command = `creds=$(/bin/cat '${project}/creds-${i}'); peer=$(/bin/cat '${project}/peer-${i}'); /usr/bin/curl --fail --silent --show-error --max-time 3 --noproxy '' http://127.0.0.1:${own.port}/${token}-own >/dev/null; printf 'own:%s\\n' "$?"; /usr/bin/curl --fail --silent --show-error --max-time 3 --noproxy '' http://127.0.0.1:${peer.port}/${token}-denied >/dev/null; printf 'denied:%s\\n' "$?"; /usr/bin/curl --fail --silent --show-error --max-time 3 --noproxy '' --proxy "$peer" http://127.0.0.1:${peer.port}/${token}-borrow >/dev/null; printf 'borrow:%s\\n' "$?"; /usr/bin/curl --fail --silent --show-error --max-time 3 --noproxy '*' http://127.0.0.1:${peer.port}/${token}-direct >/dev/null; printf 'direct:%s\\n' "$?"`;
          const credentialCommand = `${command}; /usr/bin/curl --fail --silent --show-error --max-time 3 --noproxy '' --proxy "$creds" http://127.0.0.1:${own.port}/${token}-credentials >/dev/null; printf 'credentials:%s\\n' "$?"`;
          const worker = await startMacOperationWorker(
            {
              kind: "exec",
              scope,
              args: {
                command: credentialCommand,
                cwd: project,
                timeoutMs: 15000,
                maxOutputBytes: 3000,
              },
              grant: {
                full: false,
                readRoots: [project],
                writeRoots: [],
                hosts: [`127.0.0.1:${own.port}`],
                deniedReadRoots: [stateDir],
                revision: "fixture",
              },
              stateDir,
              pythonPath: "/usr/bin/python3",
              beforeLaunch: async () => {},
              onLaunch: async (info) => {
                identities.push(info.pid);
              },
              onRuntimeReady: async (info) => {
                identities.push(info.pid);
                urls.set(i, info.proxyUrl);
                const proxy = new URL(info.proxyUrl);
                await new Promise<void>((resolve, reject) => {
                  const control = httpRequest(
                    {
                      hostname: proxy.hostname,
                      port: proxy.port,
                      path: `http://127.0.0.1:${own.port}/${token}-credential-control-own`,
                      headers: {
                        "Proxy-Authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`,
                      },
                    },
                    (response) => {
                      response.resume();
                      response.once("end", () =>
                        response.statusCode === 200
                          ? resolve()
                          : reject(new Error("Peer proxy credential positive control failed")),
                      );
                    },
                  );
                  control.once("error", reject);
                  control.end();
                });
                initialized.get(i)?.();
                await gate;
              },
            },
            AbortSignal.timeout(20000),
          );
          workers.push(worker);
          pair.push(worker);
          return worker;
        };
        await start(order[0] as number);
        await phases[order[0] as number];
        await start(order[1] as number);
        await phases[order[1] as number];
        await writeFile(join(project, "peer-0"), urls.get(1) as string, { mode: 0o600 });
        await writeFile(join(project, "peer-1"), urls.get(0) as string, { mode: 0o600 });
        for (const i of [0, 1]) {
          const peer = new URL(urls.get(1 - i) as string);
          peer.port = new URL(urls.get(i) as string).port;
          await writeFile(join(project, `creds-${i}`), peer.href, { mode: 0o600 });
        }
        gateResolve();
        await Promise.all(pair.map((w) => w.ready));
        for (const worker of pair) {
          const result = await worker.completion;
          expect(result).toMatchObject({
            exitCode: 0,
            stdout: "own:0\ndenied:22\nborrow:7\ndirect:7\ncredentials:22\n",
          });
        }
        for (const endpoint of endpoints)
          expect(endpoint.receipts.every((r) => r.endsWith("-own"))).toBe(true);
      }
    } finally {
      await Promise.all(workers.map((w) => w.cancel("owned fixture cleanup")));
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((e) => (e ? reject(e) : resolve())),
            ),
        ),
      );
    }
    for (const pid of identities) expect(() => process.kill(pid, 0)).toThrow();
  },
);

it("snapshots background environment before consumption and keeps retry hashing stable", async () => {
  const f = await fixture();
  let entered!: () => void;
  const consumed = new Promise<void>((r) => {
    entered = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  f.beforeStart(async () => {
    entered();
    await gate;
  });
  const env = { FIXTURE_VALUE: "original" };
  const scope = {
    ...f.scope,
    filesystem: { kind: "device" as const },
    network: { kind: "environment" as const },
  };
  const args = {
    command: "owned fixture",
    env,
    timeoutMs: 10000,
    maxOutputBytes: 1000,
    taskId: "task",
    outputPath: join(f.roots.tmp, "out"),
    retainUntilMs: Date.now() + 60000,
    signal,
  };
  const pending = f.backend.background.start({ id: "d" }, scope, args);
  await consumed;
  env.FIXTURE_VALUE = "mutated-after-consumption";
  release();
  const ref = await pending;
  const launched = f.launched[0] as import("../src/exec/operation-worker.js").MacWorkerRequest;
  expect(launched.kind === "exec" && launched.args.env).toEqual({ FIXTURE_VALUE: "original" });
  expect(
    await f.backend.background.start({ id: "d" }, scope, {
      ...args,
      env: { FIXTURE_VALUE: "original" },
    }),
  ).toEqual(ref);
  await expect(f.backend.background.start({ id: "d" }, scope, args)).rejects.toThrow(/hash/);
});

it.runIf(process.platform === "darwin")(
  "prepares a missing conversation subtree through the real descriptor helper",
  async () => {
    const { mkdir, realpath, stat, writeFile, readFile, symlink } = await import(
      "node:fs/promises"
    );
    const { startMacOperationWorker } = await import("../src/exec/operation-worker.js");
    const root = await realpath(await mkdtemp(join(tmpdir(), "cap-first-preparation-")));
    dirs.push(root);
    const stateDir = join(root, "state");
    const roots = {
      workspace: join(root, "workspace"),
      skills: join(root, "skills"),
      tmp: join(root, "tmp"),
    };
    for (const d of [stateDir, ...Object.values(roots)]) await mkdir(d, { mode: 0o700 });
    const base = join(roots.workspace, "attachments");
    const conversation = join(base, "123456789abc");
    const ceiling: DeviceOwnerCeiling = {
      revision: "fixture",
      fullAccess: true,
      roots,
      restrictedProjectReach: "os-user",
      restrictedAllowedDomains: [],
      restrictedDeniedReadRoots: [stateDir],
      preparation: { skillsRoot: roots.skills, attachmentsBase: base },
      fullNetwork: "environment",
    };
    const backend = await createMacOperationBackend(
      {
        deviceId: "d",
        instanceGeneration: "first",
        stateDir,
        roots,
        pythonPath: "/usr/bin/python3",
        readOwnerCeiling: async () => ceiling,
      },
      { restrictedSupported: true, platform: "darwin", startWorker: startMacOperationWorker },
    );
    let id = 0;
    const prepare = () =>
      backend.prepare(
        { id: "d" },
        {
          operationId: `first-${++id}`,
          deviceId: "d",
          purpose: "attachments",
          writeRoots: [conversation],
          tag: "first",
        },
        signal,
      );
    const marker = join(conversation, "nested", "marker");
    expect(
      await (await prepare()).stat(marker, signal).catch((e) => {
        throw new Error(`initial stat: ${e}`);
      }),
    ).toBeNull();
    expect(await (await prepare()).readFile(marker, { maxBytes: 100, signal })).toBeNull();
    await expect(stat(base)).rejects.toMatchObject({ code: "ENOENT" });
    await (await prepare()).writeFile(marker, Buffer.from("first marker"), signal).catch((e) => {
      throw new Error(`initial write: ${e}`);
    });
    expect(await (await prepare()).readFile(marker, { maxBytes: 100, signal })).toEqual({
      data: Buffer.from("first marker"),
      truncated: false,
    });
    const sibling = join(base, "fedcba987654");
    await mkdir(sibling);
    await writeFile(join(sibling, "private"), "sibling");
    await expect(
      (await prepare()).readFile(join(sibling, "private"), { maxBytes: 100, signal }),
    ).rejects.toThrow(/scope|Native/);
    await expect(
      (await prepare()).writeFile(join(sibling, "private"), Buffer.from("changed"), signal),
    ).rejects.toThrow(/scope|Native/);
    expect(await readFile(join(sibling, "private"), "utf8")).toBe("sibling");
    await symlink(sibling, join(conversation, "linked"));
    await expect(
      (await prepare()).writeFile(
        join(conversation, "linked", "private"),
        Buffer.from("changed"),
        signal,
      ),
    ).rejects.toThrow(/scope|Native/);
    const gitConversation = join(base, "abcdef123456");
    const gitPrep = await backend.prepare(
      { id: "d" },
      {
        operationId: `git-${++id}`,
        deviceId: "d",
        purpose: "attachments",
        writeRoots: [gitConversation],
        tag: "first",
      },
      signal,
    );
    await expect(
      gitPrep.writeFile(join(gitConversation, ".git", "config"), Buffer.from("changed"), signal),
    ).rejects.toThrow(/protected/);
    await expect(stat(join(gitConversation, ".git", "config"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const operation = await backend.operation(
      { id: "d" },
      {
        operationId: `optional-${++id}`,
        deviceId: "d",
        rootConversationId: "r",
        profileRevision: 0,
        ceilingRevision: "fixture",
        admitBeforeMs: Date.now() + 30000,
        profile: "approve-for-me",
        actor: { accountId: "a", conversationId: "r" },
        tag: "first",
        filesystem: {
          kind: "scoped",
          readRoots: [conversation, join(root, "missing-optional")],
          writeRoots: [],
        },
        network: { kind: "none" },
      },
      signal,
    );
    expect(await operation.readFile(marker, { maxBytes: 100, signal })).toEqual({
      data: Buffer.from("first marker"),
      truncated: false,
    });
  },
);

it("retained output controls use the exact reference without a fresh profile grant", async () => {
  const f = await fixture();
  f.hold();
  const scope = {
    ...f.scope,
    profile: "full-access" as const,
    filesystem: { kind: "device" as const },
    network: { kind: "environment" as const },
  };
  const ref = await f.backend.background.start({ id: "d" }, scope, {
    command: "fixture",
    timeoutMs: 1000,
    maxOutputBytes: 4,
    signal,
    taskId: "task",
    outputPath: join(f.roots.tmp, "retained.out"),
    retainUntilMs: Date.now() + 60000,
  });
  const reads = f.ceilingReads(),
    launches = f.launched.length;
  f.setCeiling({ fullAccess: false, restrictedDeniedReadRoots: [f.roots.tmp] });
  expect(
    await f.backend.background.readOutput({ id: "d" }, ref, { offset: 0, maxBytes: 0, signal }),
  ).toMatchObject({ totalBytes: 0, nextOffset: 0 });
  expect(f.ceilingReads()).toBe(reads);
  expect(f.launched).toHaveLength(launches);
  await expect(
    f.backend.background.readOutput({ id: "other" }, ref, { offset: 0, maxBytes: 0, signal }),
  ).rejects.toThrow(/handle/);
  await expect(
    f.backend.background.readOutput(
      { id: "d" },
      { ...ref, executionId: "wrong" },
      { offset: 0, maxBytes: 0, signal },
    ),
  ).rejects.toThrow(/reference/);
  await f.backend.background.stop({ id: "d" }, ref, { graceMs: 0, signal });
});

it("restricted artifact creation preserves implicit write denies before any owned helper launch", async () => {
  const { vi } = await import("vitest");
  const policy = await import("../src/policy.js");
  const { access, mkdir } = await import("node:fs/promises");
  const f = await fixture();
  const denied = join(f.roots.tmp, "owned-denied");
  await mkdir(denied);
  const spy = vi.spyOn(policy, "implicitWritePaths").mockReturnValue([denied]);
  try {
    const args = {
      command: "fixture",
      timeoutMs: 1000,
      maxOutputBytes: 4,
      signal,
      taskId: "task",
      outputPath: join(denied, "artifact.out"),
      retainUntilMs: Date.now() + 60000,
    };
    await expect(
      f.backend
        .forExecution({
          operationId: f.scope.operationId,
          orgNetwork: { kind: "open-public", hosts: [] },
        })
        .background.start({ id: "d" }, f.scope, args),
    ).rejects.toThrow(/protected|denied/);
    expect(f.launched).toHaveLength(0);
    await expect(access(args.outputPath)).rejects.toThrow();
    const ref = await f.backend.background.start(
      { id: "d" },
      {
        ...f.scope,
        operationId: "full-artifact",
        profile: "full-access",
        filesystem: { kind: "device" },
        network: { kind: "environment" },
      },
      args,
    );
    await f.backend.background.stop({ id: "d" }, ref, { graceMs: 0, signal });
    await access(args.outputPath);
    expect(f.launched).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});
