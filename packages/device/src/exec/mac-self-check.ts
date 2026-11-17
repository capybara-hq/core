import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExecResult, SandboxOperationScope } from "@capybara-hq/plugin-sdk";
import {
  type MacWorkerHandle,
  type MacWorkerRequest,
  startMacOperationWorker,
} from "./operation-worker.js";
import { shellQuote } from "./shared.js";

/** Trusted input of the macOS restricted self-check; nothing here comes from a request. */
export interface MacSelfCheckInput {
  /** The device's private state directory: the check's scratch directories live under it. */
  stateDir: string;
  pythonPath: string;
  /** The runtime hash the binding attested; the worker launches only that sealed runtime. */
  runtimeHash?: string;
  /** Test seams: the platform and the worker launcher. */
  platform?: NodeJS.Platform;
  startWorker?: (request: MacWorkerRequest, signal: AbortSignal) => Promise<MacWorkerHandle>;
}

/**
 * The worker self-check a macOS binding runs before it reports restricted support (permission
 * activation B-27): a real restricted worker, launched from the sealed runtime the binding
 * attested, must write and remove a file inside its one write root and must be refused a write
 * to a sibling directory outside it, with no network. Together with the verified manifest (the
 * seal exists only after `verifyInstalledRuntime` succeeded in this process) this is the proof
 * that restricted execution holds here. Returns null when it holds, else why not; never throws.
 */
export async function macRestrictedSelfCheck(
  input: MacSelfCheckInput,
  signal: AbortSignal,
): Promise<string | null> {
  if ((input.platform ?? process.platform) !== "darwin")
    return "Restricted execution with this backend needs macOS";
  if (!input.runtimeHash)
    return "Restricted macOS execution needs an instance binding with an attested runtime";
  const scratch = join(input.stateDir, `restricted-check-${randomUUID()}`);
  try {
    await mkdir(scratch, { mode: 0o700 });
    const base = await realpath(scratch);
    const allowed = join(base, "allowed");
    const denied = join(base, "denied");
    await mkdir(allowed, { mode: 0o700 });
    await mkdir(denied, { mode: 0o700 });
    const probe = (dir: string) => shellQuote(join(dir, "probe"));
    // exit 3: the write outside the root went through; any other failure: the allowed one did not
    const command =
      `: > ${probe(allowed)} && rm ${probe(allowed)} && ` +
      `if (: > ${probe(denied)}) 2>/dev/null; then exit 3; fi`;
    const operationId = `self-check-${randomUUID()}`;
    const scope: SandboxOperationScope = {
      operationId,
      admitBeforeMs: Date.now() + 60_000,
      deviceId: "self-check",
      rootConversationId: "self-check",
      profileRevision: 0,
      ceilingRevision: "self-check",
      profile: "request-approval",
      actor: { accountId: "self-check", conversationId: "self-check" },
      tag: operationId,
      filesystem: { kind: "scoped", readRoots: [], writeRoots: [allowed] },
      network: { kind: "none" },
    };
    const request: MacWorkerRequest = {
      kind: "exec",
      scope,
      grant: {
        full: false,
        readRoots: [],
        writeRoots: [allowed],
        hosts: [],
        deniedReadRoots: [],
        revision: "self-check",
      },
      stateDir: input.stateDir,
      pythonPath: input.pythonPath,
      runtimeHash: input.runtimeHash,
      beforeLaunch: async () => signal.throwIfAborted(),
      onLaunch: async () => {},
      args: { command, timeoutMs: 20_000, maxOutputBytes: 4096 },
    };
    const worker = await (input.startWorker ?? startMacOperationWorker)(request, signal);
    await worker.ready;
    const result = (await worker.completion) as ExecResult;
    if (result.exitCode === 0 && !result.timedOut) return null;
    return `Restricted macOS execution does not hold here (the self-check exited ${result.exitCode}${result.timedOut ? ", timed out" : ""})`;
  } catch (error) {
    return `The restricted macOS self-check failed: ${(error as Error).message}`;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
