import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxOperationScope } from "@capybara-hq/plugin-sdk";
import { expect, it } from "vitest";
import { createMacOperationBackend } from "../src/exec/mac-operation-backend.js";
import { type DeviceOwnerCeiling, intersectOperation } from "../src/exec/operation-types.js";
import { startMacOperationWorker } from "../src/exec/operation-worker.js";

it.runIf(process.platform === "darwin")(
  "canonical Full and restricted native calls use the real descriptor backend without execution grants",
  async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cap-permission-native-")));
    const roots = {
      workspace: join(dir, "work"),
      skills: join(dir, "skills"),
      tmp: join(dir, "tmp"),
    };
    const stateDir = join(dir, "state"),
      outside = join(dir, "outside");
    try {
      for (const path of [...Object.values(roots), stateDir, outside])
        await mkdir(path, { mode: 0o700 });
      await writeFile(join(outside, "owned"), "outside");
      const ceiling: DeviceOwnerCeiling = {
        revision: "fixture",
        fullAccess: true,
        roots,
        restrictedProjectReach: "os-user",
        restrictedAllowedDomains: [],
        restrictedDeniedReadRoots: [stateDir],
        preparation: {
          skillsRoot: roots.skills,
          attachmentsBase: join(roots.workspace, "attachments"),
        },
        fullNetwork: "environment",
      };
      const backend = await createMacOperationBackend(
        {
          deviceId: "owned",
          instanceGeneration: "fixture",
          stateDir,
          roots,
          pythonPath: "/usr/bin/python3",
          readOwnerCeiling: async () => ceiling,
        },
        {
          platform: "darwin",
          restrictedSupported: true,
          startWorker: startMacOperationWorker,
          watch: () => () => {},
        },
      );
      let ordinal = 0;
      const scope = (full: boolean): SandboxOperationScope => ({
        operationId: `owned-${++ordinal}`,
        admitBeforeMs: Date.now() + 30000,
        deviceId: "owned",
        rootConversationId: "root",
        profileRevision: 0,
        ceilingRevision: "fixture",
        profile: full ? "full-access" : "request-approval",
        actor: { accountId: "owner", conversationId: "root" },
        tag: "owned",
        filesystem: full
          ? { kind: "device" }
          : { kind: "scoped", readRoots: [roots.workspace], writeRoots: [roots.workspace] },
        network: { kind: full ? "environment" : "none" },
      });
      const signal = new AbortController().signal;
      const fullRead = await backend.operation({ id: "owned" }, scope(true), signal);
      expect(
        await fullRead.readFile(join(outside, "owned"), { maxBytes: 100, signal }),
      ).toMatchObject({ data: Buffer.from("outside") });
      const fullWrite = await backend.operation({ id: "owned" }, scope(true), signal);
      await fullWrite.writeFile(join(outside, "written"), Buffer.from("full"), signal);
      expect(await readFile(join(outside, "written"), "utf8")).toBe("full");
      const restrictedWrite = await backend.operation({ id: "owned" }, scope(false), signal);
      await restrictedWrite.writeFile(
        join(roots.workspace, "written"),
        Buffer.from("restricted"),
        signal,
      );
      const restrictedRead = await backend.operation({ id: "owned" }, scope(false), signal);
      expect(
        await restrictedRead.readFile(join(roots.workspace, "written"), { maxBytes: 100, signal }),
      ).toMatchObject({ data: Buffer.from("restricted") });
      await expect(
        (await backend.operation({ id: "owned" }, scope(false), signal)).readFile(
          join(outside, "owned"),
          { maxBytes: 100, signal },
        ),
      ).rejects.toThrow();
      expect(() =>
        intersectOperation({ ...scope(true), network: { kind: "none" } }, ceiling, undefined, true),
      ).toThrow(/Full ceiling/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
