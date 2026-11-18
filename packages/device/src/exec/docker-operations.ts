import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  DEFAULT_SANDBOX_ROOTS,
  type SandboxRoots,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import {
  checkLinuxRestrictedGrant,
  type LinuxBackendDependencies,
  type LocalOperationBackend,
} from "./linux-operation-backend.js";
import { DEVICE_PROCESS_TOKEN, linuxOperationWorker } from "./linux-operation-worker.js";
import {
  agentArgv,
  checkRestrictedRoot,
  type LinuxAgentTransport,
  linuxRuntimeBundle,
  probeLinuxRuntime,
  reapLinuxSession,
} from "./linux-runtime.js";
import {
  createLocalOperationBackend,
  type MacOperationBackendOptions,
} from "./mac-operation-backend.js";
import {
  type NativeHelperResult,
  type PinnedNativeRoot,
  runNativeHelper,
} from "./native-helper-client.js";
import { type DeviceOwnerCeiling, within } from "./operation-types.js";
import {
  createCancellationAttempt,
  type MacWorkerHandle,
  type MacWorkerRequest,
} from "./operation-worker.js";
import { acquireSealedRuntime, stageRuntimeSource } from "./runtime-source.js";

/** What the device container lends one operation: its running container, held until release. */
export interface OperationContainerHost {
  operationContainer(
    signal: AbortSignal,
  ): Promise<{ name: string; user: string; release: () => void }>;
}

/** The image's interpreter, by absolute path (never looked up through a PATH). */
const CONTAINER_PYTHON = "/usr/bin/python3";
const CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** A container command's starting environment: the image's ordinary one, never this host's. */
export function containerBaseEnv(full: boolean): Record<string, string> {
  return full
    ? {
        PATH: CONTAINER_PATH,
        LANG: "C.UTF-8",
        HOME: DEFAULT_SANDBOX_ROOTS.workspace,
        TMPDIR: DEFAULT_SANDBOX_ROOTS.tmp,
        TERM: "dumb",
      }
    : { PATH: CONTAINER_PATH, LANG: "C.UTF-8" };
}

/**
 * Ends an agent left inside the container after its `docker exec` client died: the exact process
 * (PID plus start time, checked again before each signal) gets SIGTERM, then SIGKILL, and this
 * returns once it is gone.
 */
const END_AGENT = String.raw`
import os, sys, time
pid, start = int(sys.argv[1]), int(sys.argv[2])
def same():
    try:
        with open("/proc/%d/stat" % pid) as handle:
            data = handle.read()
    except OSError:
        return False
    fields = data[data.rindex(")") + 2:].split()
    return int(fields[19]) == start and fields[0] not in ("Z", "X")
for signum, rounds in ((15, 200), (9, 2000)):
    for _ in range(rounds):
        if not same():
            sys.exit(0)
        try:
            os.kill(pid, signum)
        except OSError:
            pass
        time.sleep(0.01)
sys.exit(1)
`;

/**
 * Agents in the device's local container: one `docker exec` per operation as the container user,
 * with the agent's source inline (nothing staged in the container). The container stays held
 * (never recreated) until the agent is gone; the end of the exec's stdin tells the agent the device
 * was lost, and an agent whose client died is ended exactly before the container is released.
 */
export function dockerLinuxTransport(host: OperationContainerHost): LinuxAgentTransport {
  const bundle = linuxRuntimeBundle();
  return {
    kind: "docker",
    bundle,
    spawn: async (signal) => {
      const container = await host.operationContainer(signal ?? new AbortController().signal);
      try {
        const child = spawn(
          "docker",
          ["exec", "-i", "-u", container.user, container.name, CONTAINER_PYTHON, ...agentArgv()],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        let agent: { pid: number; start: number } | undefined;
        let head = "";
        const tap = (b: Buffer) => {
          head += b.toString("utf8");
          const end = head.indexOf("\n");
          if (end < 0 && head.length < 4096) return;
          child.stdout?.off("data", tap);
          try {
            const first = JSON.parse(head.slice(0, end)) as {
              event?: string;
              pid?: number;
              start?: number;
            };
            if (
              first.event === "agent" &&
              Number.isSafeInteger(first.pid) &&
              Number.isSafeInteger(first.start)
            )
              agent = { pid: first.pid as number, start: first.start as number };
          } catch {}
        };
        child.stdout?.on("data", tap);
        child.once("close", (_code, signalCode) => {
          if (!signalCode || !agent) return container.release();
          // the client was killed: the agent may still run inside; end it exactly first
          const ender = spawn(
            "docker",
            [
              "exec",
              "-u",
              container.user,
              container.name,
              CONTAINER_PYTHON,
              "-I",
              "-c",
              END_AGENT,
              String(agent.pid),
              String(agent.start),
            ],
            { stdio: "ignore" },
          );
          ender.once("close", container.release);
          ender.once("error", container.release);
        });
        child.once("error", container.release);
        return child;
      } catch (error) {
        container.release();
        throw error;
      }
    },
  };
}

/**
 * The owner's ceiling as the container sees it: the same authority over the container's mounted
 * roots. Nothing the owner denies on the host (secrets, the device's state) is mounted there.
 */
export function containerCeiling(ceiling: DeviceOwnerCeiling): DeviceOwnerCeiling {
  const roots = DEFAULT_SANDBOX_ROOTS;
  return Object.freeze({
    ...ceiling,
    roots: Object.freeze({ ...roots }),
    restrictedDeniedReadRoots: Object.freeze([]),
    preparation: Object.freeze({
      skillsRoot: roots.skills,
      attachmentsBase: join(roots.workspace, "attachments"),
    }),
  });
}

/** A container path inside the workspace or tmp bind mount, as the host path behind it. */
export function hostPathOf(path: string, hostRoots: SandboxRoots): string | undefined {
  for (const key of ["workspace", "tmp", "skills"] as const) {
    const root = DEFAULT_SANDBOX_ROOTS[key];
    if (within(path, root)) return hostRoots[key] + path.slice(root.length);
  }
  return undefined;
}

/**
 * Trusted skill preparation for a container device: the skills mount is read-only inside the
 * container, so the fixed native helper writes the host directory behind it on pinned
 * descriptors (descriptor-relative, no-follow; missing roots established component by component).
 */
function hostSkillsPreparation(
  request: MacWorkerRequest & { kind: "native" },
  hostRoots: SandboxRoots,
  pythonPath: string,
  stateDir: string,
  acquire: (runtimeHash: string | undefined) => Promise<{ release(): void }>,
  signal: AbortSignal,
): MacWorkerHandle {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let readyResolve!: () => void;
  let readyReject!: (e: unknown) => void;
  const ready = new Promise<void>((a, b) => {
    readyResolve = a;
    readyReject = b;
  });
  void ready.catch(() => {});
  const files: FileHandle[] = [];
  const completion = (async (): Promise<NativeHelperResult> => {
    try {
      (await acquire(request.runtimeHash)).release();
      const roots: PinnedNativeRoot[] = [];
      for (const root of request.grant.writeRoots) {
        const host = hostPathOf(root, hostRoots);
        if (!host || !within(root, DEFAULT_SANDBOX_ROOTS.skills))
          throw new SandboxScopeDeniedError("Skill preparation roots stay inside the skills mount");
        let anchor = host;
        const components: string[] = [];
        for (;;) {
          try {
            if ((await realpath(anchor)) !== anchor)
              throw new SandboxScopeDeniedError("A skill root contains a link");
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || anchor === hostRoots.skills)
              throw error;
            components.unshift(basename(anchor));
            anchor = dirname(anchor);
          }
        }
        const file = await open(
          anchor,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        files.push(file);
        roots.push({ path: host, fd: file.fd, access: "write", components });
      }
      const path = hostPathOf(request.native.path, hostRoots);
      if (!path) throw new SandboxScopeDeniedError("Preparation path is outside the mounts");
      return await runNativeHelper(
        { ...request.native, path },
        roots,
        {
          pythonPath,
          helperPath: await stageRuntimeSource(stateDir),
          ...(request.onDiagnostic ? { onDiagnostic: request.onDiagnostic } : {}),
          onLaunch: async (pid) => {
            await request.onLaunch({ pid, token: "skills", process: DEVICE_PROCESS_TOKEN });
          },
          beforeDispatch: async () => {
            await request.beforeLaunch();
            readyResolve();
          },
        },
        controller.signal,
      );
    } catch (error) {
      readyReject(error);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      await Promise.all(files.map((f) => f.close()));
    }
  })();
  void completion.catch(() => {});
  const cancel = createCancellationAttempt(async () => {
    controller.abort("Owned cancellation");
    await completion.catch(() => {});
  });
  return { ready, completion, cancel: async (_reason, graceMs = 0) => cancel(graceMs) };
}

/** Construction input of the local-Docker operation backend (trusted; never from a request). */
export interface DockerOperationBackendOptions
  extends Omit<MacOperationBackendOptions, "roots" | "readOwnerCeiling"> {
  /** The host directories mounted at the container's workspace, skills and tmp. */
  hostRoots: SandboxRoots;
  /** The owner's ceiling on the host; the backend maps it to the container. */
  readOwnerCeiling: () => Promise<DeviceOwnerCeiling>;
  container: OperationContainerHost;
}

/**
 * The local-Docker device's operation backend: the Linux backend with its agents inside the
 * device's container (same launcher, pinned roots, broker, native helper and Full semantics), on
 * the container's paths. Background artifacts are written by the trusted supervisor to the host
 * directories behind the bind mounts; skill preparation writes the host skills directory.
 */
export async function createDockerOperationBackend(
  options: DockerOperationBackendOptions,
  // no toolHome: a command in the container has the image's home, not the host user's
  dependencies: Omit<LinuxBackendDependencies, "transport" | "baseEnv" | "toolHome"> = {},
): Promise<LocalOperationBackend> {
  const transport = dockerLinuxTransport(options.container);
  let probe = await (dependencies.probe ?? (() => probeLinuxRuntime(transport)))();
  if (probe.restricted !== null && !dependencies.probe) {
    // the kernel supports it; the bind mounts must keep Landlock's rules as well
    const failure = await checkRestrictedRoot(
      transport,
      DEFAULT_SANDBOX_ROOTS.tmp,
      containerBaseEnv(false),
    );
    if (failure) probe = { restricted: null, reason: failure };
  }
  const unavailableReason =
    dependencies.restrictedSupported === false
      ? "Restricted execution is switched off for this device"
      : probe.restricted === null
        ? `Restricted execution in the device container is unavailable: ${probe.reason ?? "the runtime probe failed"}`
        : !options.runtimeHash
          ? "Restricted execution needs an instance binding with an attested runtime"
          : undefined;
  const acquire = dependencies.acquireRuntime ?? acquireSealedRuntime;
  const worker =
    dependencies.startWorker ??
    linuxOperationWorker({
      transport,
      baseEnv: containerBaseEnv,
      acquireRuntime: acquire,
      ...(dependencies.allowPrivateProxyTargets ? { allowPrivateProxyTargets: true } : {}),
    });
  const startWorker = async (
    request: MacWorkerRequest,
    signal: AbortSignal,
  ): Promise<MacWorkerHandle> =>
    request.kind === "native" &&
    request.purpose === "preparation" &&
    request.grant.writeRoots.length > 0 &&
    request.grant.writeRoots.every((root) => within(root, DEFAULT_SANDBOX_ROOTS.skills))
      ? hostSkillsPreparation(
          request,
          options.hostRoots,
          options.pythonPath,
          options.stateDir,
          acquire,
          signal,
        )
      : worker(request, signal);
  return createLocalOperationBackend(
    {
      ...options,
      roots: DEFAULT_SANDBOX_ROOTS,
      readOwnerCeiling: async () => containerCeiling(await options.readOwnerCeiling()),
    },
    {
      ...(dependencies.now ? { now: dependencies.now } : {}),
      ...(dependencies.watch ? { watch: dependencies.watch } : {}),
    },
    {
      restricted: unavailableReason === undefined,
      ...(unavailableReason ? { unavailableReason } : {}),
      fullAccess: probe.agentAvailable !== false,
      background: probe.agentAvailable !== false,
      pending: unavailableReason ?? "Restricted execution in the device container is unavailable",
      startWorker,
      checkRestrictedGrant: checkLinuxRestrictedGrant,
      artifactTarget: ({ outputPath, artifactRoot }) => {
        const path = hostPathOf(outputPath, options.hostRoots);
        // the artifact root is the mount (or a granted root inside it) holding the target
        const mount = (["workspace", "tmp"] as const).find((key) =>
          within(outputPath, DEFAULT_SANDBOX_ROOTS[key]),
        );
        if (!path || !mount)
          throw new SandboxScopeDeniedError(
            "A background artifact of a container device must be inside /workspace or /tmp",
          );
        const root = within(artifactRoot, DEFAULT_SANDBOX_ROOTS[mount])
          ? (hostPathOf(artifactRoot, options.hostRoots) as string)
          : options.hostRoots[mount];
        return { outputPath: path, artifactRoot: root };
      },
      reapOrphan: (identity) => {
        if (!identity.session || identity.process === DEVICE_PROCESS_TOKEN) return;
        // another process recorded it: only while its leader still runs with that start time
        void reapLinuxSession(transport, identity.session, { requireLeader: true }).catch((error) =>
          dependencies.onReapError?.(error),
        );
      },
    },
  );
}
