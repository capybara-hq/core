import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import {
  type ExecResult,
  SANDBOX_MANDATORY_WRITE_DENIES,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import {
  type AgentEvent,
  agentLine,
  type LinuxAgentTransport,
  type RecordedSession,
  reapLinuxSession,
} from "./linux-runtime.js";
import type { NativeHelperResult } from "./native-helper-client.js";
import {
  createCancellationAttempt,
  type MacWorkerHandle,
  type MacWorkerRequest,
  type TrustedLaunchIdentity,
} from "./operation-worker.js";
import { onDisk, protectedChain } from "./protected-targets.js";
import { acquireSealedRuntime } from "./runtime-source.js";
import { ENV_NAME_RE, OutputCap, restrictedToolHomes, shellQuote } from "./shared.js";

/** This device process: a later one reaps sessions recorded under another token. */
export const DEVICE_PROCESS_TOKEN = randomUUID();

/** A frame the managed output sink accepts at once. */
const FRAME = 65536;
/** How long an agent may take to end what it owns after a cancel before it is killed. */
const CANCEL_SETTLE_MS = 15_000;

export interface LinuxWorkerOptions {
  transport: LinuxAgentTransport;
  /**
   * The device's files lock, as the agent sees it: one file per device, outside every sandbox
   * (on a host, in the device's state directory, which restricted work is denied; in the device's
   * container, on its private /dev/shm, which no Landlock rule grants). Every restricted
   * operation's broker, and the agent's own restricted native writes, hold it shared from a
   * write's check to its effect; the broker holds it exclusively for a directory move into a
   * guarded place, so no operation's move can slip between another operation's check and write.
   */
  filesLock: string;
  /**
   * The environment a command starts from: an escalated call (outside the sandbox) gets the OS
   * user's own environment without the device's own variables (on the host, this process's minus
   * every `CAPYBARA_*`; in the container, the image's), a sandboxed one only a fixed outer set.
   */
  baseEnv(escalated: boolean): Record<string, string>;
  /**
   * The OS user's real home and the device process's own environment: a restricted command gets
   * their version manager variables and reads those directories ({@link restrictedToolHomes}).
   * Host only; a command in the device's container keeps the image's home and gets none.
   */
  toolHome?: { home: string; env: Record<string, string | undefined> };
  /**
   * The runtime-hash gate (W1-B) every restricted launch passes before anything starts: the
   * binding's attested runtime must be the one verified and sealed in this process, unchanged.
   */
  acquireRuntime?: (runtimeHash: string | undefined) => Promise<{ release(): void }>;
  /** How long an agent may take to end what it owns after a cancel (default 15 s). */
  cancelSettleMs?: number;
  /**
   * Test seam (trusted construction only): let the allowlist proxy reach loopback and private
   * addresses, as a conformance fixture's local endpoints need.
   */
  allowPrivateProxyTargets?: boolean;
  /**
   * Test seam (trusted construction only): the encrypted DNS a fake-IP answer is re-resolved
   * through (a fixture's DoH endpoint and the certificate it presents) instead of the SDK's
   * `SANDBOX_FAKE_IP_DNS` endpoints, which a test network cannot reach.
   */
  fakeIpDnsTest?: { endpoints: string[]; caPem: string };
  /**
   * Extra addresses the forwarder closes besides its own host's: a local-Docker device's agents
   * run in a container, whose own addresses are not the host's, so the host's interface addresses
   * (a public one included) are closed explicitly. Read at each operation start.
   */
  closedAddresses?: () => string[];
  /**
   * Test seam (trusted construction only): faults the launcher injects, so a test can drive a
   * path no real kernel produces on demand (`stagedMove: "fail"`: a guarded directory move whose
   * final rename and move back both fail, which quarantines it and ends the operation;
   * `pauseBeforeMkdir`: a mkdir of that name pauses between its check and its effect).
   */
  faultInjection?: LinuxFaultInjection;
}

/** The launcher's test-only faults; see {@link LinuxWorkerOptions.faultInjection}. */
export interface LinuxFaultInjection {
  stagedMove?: "fail";
  pauseBeforeMkdir?: string;
}

/**
 * The anchored write denies of the protected home locations (each
 * {@link SANDBOX_MANDATORY_WRITE_DENIES} entry under `home`) reached through a symbolic link,
 * resolved with the workers' shared {@link protectedChain}: every link on the chain (also with its
 * parent in on-disk form) and each final target. They go to the launcher as absolute denies,
 * resolved once at operation start; the write policy then refuses moving an ancestor of one away,
 * so no hop can be swapped within the operation. A link changed outside the sandbox is seen by the
 * next operation; a dangling link is followed to the location it names.
 */
export function protectedWriteTargets(home: string): string[] {
  const out = new Set<string>();
  for (const entry of SANDBOX_MANDATORY_WRITE_DENIES) {
    const chain = protectedChain(join(home, ...entry));
    if (!chain.links.length) continue;
    out.add(chain.target);
    for (const link of chain.links) {
      out.add(link);
      out.add(join(onDisk(dirname(link)), basename(link)));
    }
  }
  return [...out];
}

function refusal(event: AgentEvent): Error {
  const message = String(event.message ?? "The operation agent refused the operation");
  switch (event.code) {
    case "UNAVAILABLE":
      return new SandboxPermissionUnsupportedError(message);
    case "SCOPE_DENIED":
    case "ROOT_CHANGED":
      return new SandboxScopeDeniedError(message);
    default:
      return new Error(message);
  }
}

/**
 * Starts Linux operations through the trusted agent (on the host or in the device's container),
 * with the same handle semantics as the macOS worker: `ready` once the exact owned identity is
 * recorded, `completion` with the result, and an exact, coalesced `cancel`. Abort cancels at once;
 * a lost agent's recorded session is reaped, never resumed.
 */
export function linuxOperationWorker(
  options: LinuxWorkerOptions,
): (request: MacWorkerRequest, signal: AbortSignal) => Promise<MacWorkerHandle> {
  const acquire = options.acquireRuntime ?? acquireSealedRuntime;
  return async (request, signal) => {
    signal.throwIfAborted();
    let readyResolve!: () => void;
    let readyReject!: (e: unknown) => void;
    const ready = new Promise<void>((a, b) => {
      readyResolve = a;
      readyReject = b;
    });
    void ready.catch(() => {});
    let child: ChildProcess | undefined;
    let session: RecordedSession | undefined;
    let finished = false;
    let cancelled = false;
    let final: AgentEvent | undefined;
    const controller = new AbortController();
    const sendCancel = (graceMs: number) => {
      if (child?.stdin?.writable)
        child.stdin.write(`${JSON.stringify({ op: "cancel", graceMs })}\n`);
    };
    const reapLost = async () => {
      if (session) await reapLinuxSession(options.transport, session);
    };
    const completion = (async (): Promise<ExecResult | NativeHelperResult> => {
      let closed: Promise<void> | undefined;
      try {
        if (!request.grant.full) (await acquire(request.runtimeHash)).release();
        // only restricted exec on the host: native work never runs a version manager
        const toolHomes =
          request.kind === "exec" && !request.grant.full && options.toolHome
            ? restrictedToolHomes(
                options.toolHome.home,
                options.toolHome.env,
                request.grant.deniedReadRoots,
              )
            : undefined;
        // only on the host: a command in the device's container has the image's home
        const writeDenies =
          !request.grant.full && options.toolHome
            ? protectedWriteTargets(options.toolHome.home)
            : [];
        const roots = request.grant.full
          ? {}
          : {
              readRoots: [
                ...new Set([...request.grant.readRoots, ...(toolHomes?.readRoots ?? [])]),
              ],
              writeRoots: [...request.grant.writeRoots],
              ...(writeDenies.length ? { writeDenies } : {}),
            };
        let body: Record<string, unknown>;
        let cap: OutputCap | undefined;
        if (request.kind === "native") {
          body = {
            op: "native",
            full: request.grant.full,
            ...roots,
            ...(request.grant.full ? {} : { denied: [...request.grant.deniedReadRoots] }),
            ...(options.faultInjection ? { faultInjection: options.faultInjection } : {}),
            filesLock: options.filesLock,
            native: request.native,
          };
        } else {
          const args = request.args;
          for (const key of Object.keys(args.env ?? {}))
            if (!ENV_NAME_RE.test(key)) throw new Error("Invalid environment variable name");
          const env = {
            ...toolHomes?.env,
            ...options.baseEnv(request.grant.full),
            ...(request.grant.full
              ? {}
              : { HOME: args.cwd ?? "/", TMPDIR: request.grant.writeRoots[0] ?? "/tmp" }),
            ...(args.env ?? {}),
          };
          cap = new OutputCap(args.maxOutputBytes);
          body = {
            op: "exec",
            full: request.grant.full,
            ...roots,
            // the escalated call's own network; the open public network through the forwarder
            // (the closed address classes refused); or exactly the granted hosts
            network: {
              kind: request.grant.full
                ? "environment"
                : request.grant.openNetwork
                  ? "open"
                  : "allowlist",
              hosts: request.grant.openNetwork ? [] : [...request.grant.hosts],
            },
            // single read-only files (a global version pin); the agent grants each exactly
            ...(toolHomes?.readFiles.length ? { readFiles: toolHomes.readFiles } : {}),
            // background output is one merged stream; its stderr is the launcher's diagnostics
            ...(options.allowPrivateProxyTargets ? { allowPrivate: true } : {}),
            ...(options.fakeIpDnsTest ? { dohTest: options.fakeIpDnsTest } : {}),
            ...(options.closedAddresses ? { closedAddresses: options.closedAddresses() } : {}),
            ...(options.faultInjection ? { faultInjection: options.faultInjection } : {}),
            filesLock: options.filesLock,
            command: request.managedOutput
              ? `exec /bin/bash -c ${shellQuote(args.command)} 2>&1`
              : args.command,
            cwd: args.cwd,
            env,
            timeoutMs: args.timeoutMs,
          };
        }
        await request.beforeLaunch();
        controller.signal.throwIfAborted();
        const agent = await options.transport.spawn(controller.signal);
        child = agent;
        closed = new Promise<void>((resolve, reject) => {
          agent.once("error", reject);
          agent.once("close", () => resolve());
        });
        void closed.catch(() => {});
        agent.stdin?.on("error", () => {});
        // stdin stays open: it carries cancellation, and its end tells the agent we were lost
        agent.stdin?.write(agentLine(options.transport, body));
        let diagnosticBytes = 0;
        agent.stderr?.on("data", (b: Buffer) => {
          diagnosticBytes += b.length;
          if (diagnosticBytes <= 65536) request.onDiagnostic?.(b.toString("utf8"));
        });
        let outputFault: unknown;
        let chain: Promise<void> = Promise.resolve();
        const handle = async (event: AgentEvent) => {
          switch (event.event) {
            case "launched": {
              const recorded = event.session as RecordedSession | undefined;
              if (recorded) session = { sid: Number(recorded.sid), start: Number(recorded.start) };
              const identity: TrustedLaunchIdentity = {
                pid: agent.pid as number,
                token: randomUUID(),
                process: DEVICE_PROCESS_TOKEN,
                ...(session ? { session } : {}),
              };
              await request.onLaunch(identity);
              readyResolve();
              return;
            }
            case "output": {
              const bytes = Buffer.from(String(event.data), "base64");
              const stream = event.stream === 2 ? "stderr" : "stdout";
              if (!request.managedOutput) {
                cap?.push(stream, bytes);
                void request.onOutput?.(bytes, stream);
                return;
              }
              if (stream === "stderr") {
                request.onDiagnostic?.(bytes.toString("utf8"));
                return;
              }
              if (outputFault) return;
              for (let offset = 0; offset < bytes.length; offset += FRAME) {
                const frame = bytes.subarray(offset, offset + FRAME);
                cap?.push("stdout", frame);
                try {
                  await request.onOutput?.(frame, "stdout");
                } catch (error) {
                  outputFault = error;
                  cancelled = true;
                  sendCancel(0);
                  return;
                }
              }
              return;
            }
            default:
              if (["exit", "native", "refused"].includes(event.event)) final = event;
          }
        };
        let buffered = "";
        const stdout = agent.stdout as Readable;
        stdout.on("data", (b: Buffer) => {
          buffered += b.toString("utf8");
          const lines: AgentEvent[] = [];
          for (let i = buffered.indexOf("\n"); i >= 0; i = buffered.indexOf("\n")) {
            const line = buffered.slice(0, i);
            buffered = buffered.slice(i + 1);
            try {
              lines.push(JSON.parse(line) as AgentEvent);
            } catch {}
          }
          if (!lines.length) return;
          // ordered, and with backpressure: the agent (and its command) waits for the sink
          stdout.pause();
          chain = chain
            .then(async () => {
              for (const event of lines) await handle(event);
            })
            .catch((error) => {
              outputFault ??= error;
              cancelled = true;
              sendCancel(0);
            })
            .finally(() => stdout.resume());
        });
        if (cancelled) sendCancel(0);
        await closed;
        await chain;
        if (outputFault) throw outputFault;
        const result = final;
        if (!result) {
          await reapLost();
          if (controller.signal.aborted) throw controller.signal.reason;
          throw new Error("The operation agent was lost; its owned session was ended");
        }
        if (result.event === "refused") {
          if (controller.signal.aborted) throw controller.signal.reason;
          throw refusal(result);
        }
        if (result.event === "native") {
          const response = result.response as {
            result?: NativeHelperResult;
            error?: { code: string; message: string };
          };
          if (response?.error) {
            if (["SCOPE_DENIED", "EACCES", "EPERM", "ELOOP"].includes(response.error.code))
              throw new SandboxScopeDeniedError(response.error.message);
            throw new Error(response.error.message);
          }
          return response?.result ?? null;
        }
        if (typeof result.fatal === "string")
          throw new Error(`The restricted launcher ended the operation: ${result.fatal}`);
        if (result.supervisorLost === true && !cancelled)
          throw new Error("The restricted launcher was lost; its owned session was ended");
        const timedOut = result.timedOut === true;
        return {
          exitCode:
            cancelled || timedOut || result.cancelled === true
              ? null
              : (result.exitCode as number | null),
          stdout: cap?.text("stdout") ?? "",
          stderr: cap?.text("stderr") ?? "",
          truncated: cap?.truncated ?? false,
          timedOut,
        };
      } catch (e) {
        readyReject(e);
        throw e;
      } finally {
        finished = true;
        signal.removeEventListener("abort", abort);
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await closed?.catch(() => {});
          await reapLost().catch((error) =>
            request.onDiagnostic?.(`Reaping the owned session failed: ${(error as Error).message}`),
          );
        }
      }
    })();
    void completion.catch(() => {});
    const cancelAttempt = createCancellationAttempt(async (graceMs) => {
      if (finished) return;
      cancelled = true;
      if (!controller.signal.aborted) controller.abort("Owned cancellation");
      if (child) {
        sendCancel(graceMs);
        let timer: NodeJS.Timeout | undefined;
        const settled = await Promise.race([
          completion.then(
            () => true,
            () => true,
          ),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(
              () => resolve(false),
              graceMs + (options.cancelSettleMs ?? CANCEL_SETTLE_MS),
            );
          }),
        ]);
        clearTimeout(timer);
        if (!settled) {
          // the agent does not answer: end it, then its recorded session, exactly
          child.kill("SIGKILL");
          await reapLost();
        }
      }
      await completion.catch(() => {});
    });
    // An abort escalates like a cancel: the agent ends what it owns, or it is killed and its
    // recorded session reaped.
    function abort() {
      if (finished) return;
      controller.abort(signal.reason);
      void cancelAttempt(0).catch((error) =>
        request.onDiagnostic?.(`Owned cancellation remains pending: ${(error as Error).message}`),
      );
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return {
      ready,
      completion,
      cancel: async (_reason, graceMs = 0) => cancelAttempt(graceMs),
    };
  };
}
