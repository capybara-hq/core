import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelRequest } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createMacOperationBackend } from "../src/exec/mac-operation-backend.js";
import type { DeviceOwnerCeiling } from "../src/exec/operation-types.js";
import { startMacOperationWorker } from "../src/exec/operation-worker.js";
import { observeTransferTimings, type TransferTiming } from "../src/exec/transfer-timing.js";
import { serveOperationV3 } from "../src/server-ops.js";
import { sealWorkspaceRuntime } from "./runtime-seal.js";

const workspace = { runtimeHash: "", cleanup: async () => {} };
const dirs: string[] = [];
beforeAll(async () => {
  Object.assign(workspace, await sealWorkspaceRuntime());
});
afterAll(async () => {
  await workspace.cleanup();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
const signal = new AbortController().signal;

it.runIf(process.platform === "darwin")(
  "moves 5 MB through the real native helper byte-exact and reports the stage timings",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cap-transfer-")));
    dirs.push(root);
    const stateDir = join(root, "state");
    const roots = {
      workspace: join(root, "workspace"),
      skills: join(root, "skills"),
      tmp: join(root, "tmp"),
    };
    for (const d of [stateDir, ...Object.values(roots)]) await mkdir(d, { mode: 0o700 });
    const ceiling: DeviceOwnerCeiling = {
      revision: "fixture",
      fullAccess: true,
      roots,
      restrictedProjectReach: "os-user",
      restrictedAllowedDomains: [],
      restrictedDeniedReadRoots: [stateDir],
      preparation: { skillsRoot: roots.skills, attachmentsBase: join(roots.workspace, "a") },
      fullNetwork: "environment",
    };
    const backend = await createMacOperationBackend(
      {
        deviceId: "d",
        instanceGeneration: "g",
        stateDir,
        roots,
        pythonPath: "/usr/bin/python3",
        runtimeHash: workspace.runtimeHash,
        readOwnerCeiling: async () => ceiling,
      },
      { restrictedSupported: true, platform: "darwin", startWorker: startMacOperationWorker },
    );
    const timings: TransferTiming[] = [];
    const stop = observeTransferTimings((t) => timings.push(t));
    const data = randomBytes(5 * 1024 * 1024);
    let id = 0;
    const base = {
      deviceId: "d",
      rootConversationId: "r",
      profileRevision: 0,
      ceilingRevision: "fixture",
      actor: { accountId: "a", conversationId: "r" },
      tag: "transfer",
    };
    const profiles = {
      restricted: {
        profile: "approve-for-me" as const,
        filesystem: {
          kind: "scoped" as const,
          readRoots: [roots.workspace],
          writeRoots: [roots.workspace],
        },
        network: { kind: "none" as const },
      },
      full: {
        profile: "full-access" as const,
        filesystem: { kind: "device" as const },
        network: { kind: "environment" as const },
      },
    };
    const report: string[] = [];
    try {
      for (const [name, profile] of Object.entries(profiles)) {
        const path = join(roots.workspace, `${name}.bin`);
        const open = () =>
          backend.operation(
            { id: "d" },
            { ...base, ...profile, operationId: `t-${++id}`, admitBeforeMs: Date.now() + 30000 },
            signal,
          );
        // twice each way: the second run shows the cost of what the first one retained
        for (const round of [1, 2]) {
          timings.length = 0;
          await (await open()).writeFile(path, data, signal);
          expect((await readFile(path)).equals(data)).toBe(true);
          const writes = [...timings];
          timings.length = 0;
          const read = await (await open()).readFile(path, { maxBytes: data.length, signal });
          expect(read?.truncated).toBe(false);
          expect(Buffer.from(read?.data ?? []).equals(data)).toBe(true);
          const reads = [...timings];
          for (const [direction, list] of [
            ["write", writes],
            ["read", reads],
          ] as const) {
            const stages = new Map<string, number>();
            for (const t of list) {
              const key = t.method === "supervisor" ? "journal" : t.stage;
              stages.set(key, (stages.get(key) ?? 0) + t.ms);
            }
            report.push(
              `${name} ${direction} #${round}: ${[...stages]
                .map(([stage, ms]) => `${stage}=${ms.toFixed(0)}ms`)
                .join(" ")}`,
            );
          }
        }
      }
      // the whole device path of one request except the socket: frame parse, base64, backend,
      // the answer serialised as the session sends it
      const framePath = join(roots.workspace, "frame.bin");
      const serve = async (op: string, args: object) => {
        const started = performance.now();
        const res = await serveOperationV3(
          backend,
          { id: "d" },
          {
            type: "req",
            id: `f-${++id}`,
            op,
            args: {
              scope: {
                ...base,
                ...profiles.restricted,
                operationId: `t-${++id}`,
                admitBeforeMs: Date.now() + 30000,
              },
              path: framePath,
              ...args,
            },
            deadlineMs: 60000,
          } as KernelRequest,
          signal,
        );
        const wire = JSON.stringify(res);
        return { res, wire, ms: performance.now() - started };
      };
      const write = await serve("writeFile", { dataB64: data.toString("base64") });
      expect(write.res, write.wire.slice(0, 300)).toMatchObject({ ok: true });
      expect((await readFile(framePath)).equals(data)).toBe(true);
      const read = await serve("readFile", { maxBytes: data.length });
      const answer = JSON.parse(read.wire) as { result: { dataB64: string } };
      expect(Buffer.from(answer.result.dataB64, "base64").equals(data)).toBe(true);
      report.push(
        `restricted frame write: total=${write.ms.toFixed(0)}ms`,
        `restricted frame read: total=${read.ms.toFixed(0)}ms`,
      );
    } finally {
      stop();
    }
    if (process.env.CAPYBARA_DEVICE_DEBUG_TIMINGS === "1")
      console.log(`5 MB transfer stage timings\n${report.join("\n")}`);
  },
);
