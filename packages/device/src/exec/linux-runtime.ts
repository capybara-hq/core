import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { SANDBOX_RUNTIME_SOURCE, SandboxPermissionUnsupportedError } from "@capybara-hq/plugin-sdk";
import { LINUX_DEVICE_AGENT } from "./linux-agent.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * What every agent request carries: the SDK's restricted Linux launcher and native helper (bundle
 * version 2, each checked here against its shipped digest) with those digests. The agent seals the
 * bytes into memfds and checks the digests again before anything runs from them.
 */
export interface LinuxRuntimeBundle {
  runtime: Readonly<Record<string, string>>;
  expect: Readonly<Record<string, string>>;
}

export function linuxRuntimeBundle(): LinuxRuntimeBundle {
  if (SANDBOX_RUNTIME_SOURCE.version !== 2)
    throw new SandboxPermissionUnsupportedError("Unsupported sandbox runtime bundle");
  const runtime: Record<string, string> = {};
  const expect: Record<string, string> = {};
  for (const name of ["linux-sandbox.py", "native-files.py"]) {
    const file = SANDBOX_RUNTIME_SOURCE.files.find((f) => f.name === name);
    if (!file || sha256(file.source) !== file.sha256)
      throw new SandboxPermissionUnsupportedError(`The bundled ${name} does not match its digest`);
    runtime[name] = file.source;
    expect[name] = file.sha256;
  }
  return { runtime: Object.freeze(runtime), expect: Object.freeze(expect) };
}

/** The agent's command line: its source inline, so no file stands between check and run. */
export function agentArgv(): string[] {
  return ["-I", "-c", LINUX_DEVICE_AGENT];
}

/** How the device starts one operation agent: on this host, or inside its local container. */
export interface LinuxAgentTransport {
  readonly kind: "host" | "docker";
  readonly bundle: LinuxRuntimeBundle;
  /** One fresh agent process with piped stdin, stdout and stderr; an abort stops waiting. */
  spawn(signal?: AbortSignal): Promise<ChildProcess>;
}

/**
 * Runs agents on this Linux host. Each agent has its own session, so a terminal signal to
 * capybara-device never reaches it; it notices the device's loss by the end of its stdin and ends
 * what it owns.
 */
export function hostLinuxTransport(options: { pythonPath: string }): LinuxAgentTransport {
  const bundle = linuxRuntimeBundle();
  return {
    kind: "host",
    bundle,
    spawn: async (signal) => {
      signal?.throwIfAborted();
      return spawn(options.pythonPath, agentArgv(), {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      });
    },
  };
}

/** A request line with the runtime the agent seals and checks. */
export function agentLine(transport: LinuxAgentTransport, request: Record<string, unknown>) {
  return `${JSON.stringify({ ...request, runtime: transport.bundle.runtime, expect: transport.bundle.expect })}\n`;
}

/** One JSON event line of an agent. */
export type AgentEvent = { event: string } & Record<string, unknown>;

/**
 * Runs a one-shot agent request (probe, reap) and returns its final event. A refusal or an agent
 * that ends without an answer is an error.
 */
export async function agentRequest(
  transport: LinuxAgentTransport,
  request: Record<string, unknown>,
  final: string,
  timeoutMs = 60_000,
  /** Keep stdin open until the final event (an exec agent treats its end as cancellation). */
  holdInput = false,
): Promise<AgentEvent> {
  const child = await transport.spawn();
  let buffered = "";
  let answer: AgentEvent | undefined;
  let stderr = "";
  child.stdout?.on("data", (b: Buffer) => {
    buffered += b.toString("utf8");
    for (let i = buffered.indexOf("\n"); i >= 0; i = buffered.indexOf("\n")) {
      const line = buffered.slice(0, i);
      buffered = buffered.slice(i + 1);
      try {
        const event = JSON.parse(line) as AgentEvent;
        if (event.event === final || event.event === "refused") {
          answer = event;
          if (holdInput) child.stdin?.end();
        }
      } catch {}
    }
  });
  child.stderr?.on("data", (b: Buffer) => {
    if (stderr.length < 4096) stderr += b.toString("utf8");
  });
  child.stdin?.on("error", () => {});
  const line = agentLine(transport, request);
  if (holdInput) child.stdin?.write(line);
  else child.stdin?.end(line);
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
  } finally {
    clearTimeout(timer);
  }
  if (!answer)
    throw new Error(`The operation agent gave no answer: ${stderr.trim().slice(0, 500)}`);
  if (answer.event === "refused") {
    const message = String(answer.message ?? "The operation agent refused");
    throw answer.code === "UNAVAILABLE"
      ? new SandboxPermissionUnsupportedError(message)
      : new Error(message);
  }
  return answer;
}

/** The launcher's own runtime probe: restricted support, or why it is unavailable. */
export interface LinuxProbe {
  restricted: { filesystem: true; network: true; native: true; concurrentScopes: true } | null;
  reason?: string;
  arch?: string;
  landlockAbi?: number;
  /**
   * False when the agent itself cannot run (no Python 3.9+, a traced agent, no interpreter):
   * then Full access and background work are unavailable too.
   */
  agentAvailable?: boolean;
}

/**
 * The launcher's probe through the agent. It never throws: any failure is restricted unavailable
 * with its reason, so an unsupported kernel, ABI or architecture fails closed while Full access
 * keeps working.
 */
export async function probeLinuxRuntime(transport: LinuxAgentTransport): Promise<LinuxProbe> {
  try {
    const event = await agentRequest(transport, { op: "probe" }, "probe");
    const result = event.result as Partial<LinuxProbe> | undefined;
    const claims = result?.restricted;
    const complete =
      claims !== null &&
      typeof claims === "object" &&
      claims.filesystem === true &&
      claims.network === true &&
      claims.native === true &&
      claims.concurrentScopes === true;
    if (!complete)
      return {
        restricted: null,
        reason: String(result?.reason ?? "The restricted Linux runtime is unavailable"),
        ...(typeof result?.arch === "string" ? { arch: result.arch } : {}),
      };
    return {
      restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
      ...(typeof result?.arch === "string" ? { arch: result.arch } : {}),
      ...(typeof result?.landlockAbi === "number" ? { landlockAbi: result.landlockAbi } : {}),
    };
  } catch (error) {
    return {
      restricted: null,
      reason: `The operation agent cannot run: ${(error as Error).message}`,
      agentAvailable: false,
    };
  }
}

/** A closed session an agent recorded: its SID and the leader's start time. */
export interface RecordedSession {
  sid: number;
  start: number;
}

/** Ends every live member of a recorded session (after a lost agent or device process). */
export async function reapLinuxSession(
  transport: LinuxAgentTransport,
  session: RecordedSession,
  options: { requireLeader?: boolean } = {},
): Promise<number> {
  if (
    !Number.isSafeInteger(session.sid) ||
    session.sid <= 1 ||
    !Number.isSafeInteger(session.start)
  )
    throw new Error("Invalid recorded session");
  const event = await agentRequest(
    transport,
    {
      op: "reap",
      session: { sid: session.sid, start: session.start },
      ...(options.requireLeader ? { requireLeader: true } : {}),
    },
    "reaped",
  );
  return Number(event.killed);
}

/**
 * A functional self-check of restricted execution on `root` (an existing directory the device
 * user owns): a restricted command must list it and create and remove a file in it. Landlock
 * rules attach to inodes, and some file systems (Docker Desktop's file sharing, for one) do not
 * keep them, which would deny every restricted operation there. Returns why it failed, or null.
 */
export async function checkRestrictedRoot(
  transport: LinuxAgentTransport,
  root: string,
  env: Record<string, string>,
): Promise<string | null> {
  const name = `.capybara-restricted-check-${randomUUID()}`;
  try {
    const event = await agentRequest(
      transport,
      {
        op: "exec",
        full: false,
        readRoots: [],
        writeRoots: [root],
        network: { kind: "allowlist", hosts: [] },
        command: `ls . >/dev/null && : > ${name} && rm ${name}`,
        cwd: root,
        env,
        timeoutMs: 20_000,
      },
      "exit",
      60_000,
      true,
    );
    return event.exitCode === 0
      ? null
      : `a restricted command cannot use ${root} (Landlock rules do not hold on this file system)`;
  } catch (error) {
    return `the restricted self-check on ${root} failed: ${(error as Error).message}`;
  }
}
