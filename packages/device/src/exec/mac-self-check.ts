import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, SandboxOperationScope } from "@capybara-hq/plugin-sdk";
import type { RestrictedProof } from "./mac-operation-backend.js";
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

/** What each self-check exit code means: the probe that did not hold. */
const PROBE_FAILURES: Record<number, string> = {
  3: "a write outside the write root went through",
  4: "a read of a denied path went through",
  5: "a network connection went through",
  6: "a read of an ungranted file went through",
  7: "a read of a granted file failed, so the read probes prove nothing",
};

/** Whether a TCP connection reaches a local listener while `run` runs; the listener is closed after. */
async function withListener<T>(
  run: (port: number) => Promise<T>,
): Promise<{ value: T; reached: boolean }> {
  let reached = false;
  const server = createServer((socket) => {
    reached = true;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const value = await run((server.address() as AddressInfo).port);
    return { value, reached };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * The worker self-check a macOS binding runs before it reports restricted support (permission
 * activation B-27): a real restricted worker, launched from the sealed runtime the binding
 * attested, must write and remove a file inside its one write root and read a file there (the
 * positive control of the read probes), and must be refused a write
 * to a sibling directory outside it, a read of a file under a denied read root, a read of an
 * ordinary file it was never granted (one beside its root, one in a temporary directory of its
 * own: no secret path, so only the read scope keeps them out), and a TCP connection to a
 * listener on this machine (its network is none). Together with the verified
 * manifest (the seal exists only after `verifyInstalledRuntime` succeeded in this process) this is
 * the proof that restricted execution holds here. Returns null when it holds, else why not; never
 * throws.
 */
export async function macRestrictedSelfCheck(
  input: MacSelfCheckInput,
  signal: AbortSignal,
): Promise<string | null> {
  if ((input.platform ?? process.platform) !== "darwin")
    return "Restricted execution with this backend needs macOS";
  const runtimeHash = input.runtimeHash;
  if (!runtimeHash)
    return "Restricted macOS execution needs an instance binding with an attested runtime";
  const scratch = join(input.stateDir, `restricted-check-${randomUUID()}`);
  let elsewhere: string | undefined;
  try {
    await mkdir(scratch, { mode: 0o700 });
    const base = await realpath(scratch);
    const allowed = join(base, "allowed");
    const denied = join(base, "denied");
    const hidden = join(base, "hidden");
    for (const dir of [allowed, denied, hidden]) await mkdir(dir, { mode: 0o700 });
    await writeFile(join(hidden, "secret"), "restricted self-check", { mode: 0o600 });
    // granted: the positive control the read probes are measured against
    const control = join(allowed, "control");
    await writeFile(control, "restricted self-check", { mode: 0o600 });
    // ungranted, never denied: readable only if the read scope is wider than the grant
    const ungranted = join(base, "ungranted");
    await writeFile(ungranted, "restricted self-check", { mode: 0o600 });
    elsewhere = await realpath(await mkdtemp(join(tmpdir(), "capybara-restricted-check-")));
    const unrelated = join(elsewhere, "plain");
    await writeFile(unrelated, "restricted self-check", { mode: 0o600 });
    const probe = (dir: string) => shellQuote(join(dir, "probe"));
    const { value: result, reached } = await withListener(async (port) => {
      // exit 3 to 6: a refused action went through; 7: the positive control (a granted file
      // must read, else a `cat` failing for any reason would pass every read probe); any other
      // failure: the allowed write failed
      const command =
        `: > ${probe(allowed)} && rm ${probe(allowed)} && ` +
        `if ! cat ${shellQuote(control)} >/dev/null 2>&1; then exit 7; fi; ` +
        `if (: > ${probe(denied)}) 2>/dev/null; then exit 3; fi; ` +
        `if cat ${shellQuote(join(hidden, "secret"))} >/dev/null 2>&1; then exit 4; fi; ` +
        `if cat ${shellQuote(ungranted)} >/dev/null 2>&1; then exit 6; fi; ` +
        `if cat ${shellQuote(unrelated)} >/dev/null 2>&1; then exit 6; fi; ` +
        `if (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null; then exit 5; fi`;
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
          deniedReadRoots: [hidden],
          revision: "self-check",
        },
        stateDir: input.stateDir,
        pythonPath: input.pythonPath,
        runtimeHash,
        beforeLaunch: async () => signal.throwIfAborted(),
        onLaunch: async () => {},
        args: { command, timeoutMs: 20_000, maxOutputBytes: 4096 },
      };
      const worker = await (input.startWorker ?? startMacOperationWorker)(request, signal);
      const abort = () => void worker.cancel("Self-check deadline", 0).catch(() => {});
      signal.addEventListener("abort", abort, { once: true });
      try {
        await worker.ready;
        return (await Promise.race([
          worker.completion,
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(new Error("the self-check ran out of time"));
            signal.addEventListener(
              "abort",
              () => reject(new Error("the self-check ran out of time")),
              { once: true },
            );
          }),
        ])) as ExecResult;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    });
    if (reached)
      return "Restricted macOS execution does not hold here (a network connection went through)";
    if (result.exitCode === 0 && !result.timedOut) return null;
    const what =
      PROBE_FAILURES[result.exitCode ?? -1] ??
      `the allowed write failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""})`;
    return `Restricted macOS execution does not hold here (${what})`;
  } catch (error) {
    return `The restricted macOS self-check failed: ${(error as Error).message}`;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    if (elsewhere) await rm(elsewhere, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A generation's restricted proof (M-4): the self-check result, retried after a failure when a
 * report asks (`refresh`) at most once per `retryMs`, so a transient failure (a slow first
 * launch, a busy machine) does not disable restricted execution for the whole generation. Each
 * attempt is bounded by `timeoutMs`.
 */
export function createRestrictedProof(
  check: (signal: AbortSignal) => Promise<string | null>,
  opts: { timeoutMs: number; retryMs: number; now?: () => number },
): RestrictedProof & { attempt(): Promise<void> } {
  const now = opts.now ?? Date.now;
  let failure: string | null = "Restricted macOS execution has not been checked yet";
  let last = Number.NEGATIVE_INFINITY;
  let running: Promise<void> | undefined;
  const attempt = (): Promise<void> => {
    running ??= (async () => {
      last = now();
      failure = await check(AbortSignal.timeout(opts.timeoutMs)).catch(
        (error: unknown) => `The restricted macOS self-check failed: ${String(error)}`,
      );
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
  return {
    failure: () => failure,
    attempt,
    refresh: async () => {
      if (failure === null) return;
      if (running) return running;
      if (now() - last < opts.retryMs) return;
      return attempt();
    },
  };
}
