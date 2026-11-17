import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  DEFAULT_SANDBOX_ROOTS,
  type SandboxRoots,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { OPERATION_RUNTIME_DIR } from "./docker.js";
import {
  checkLinuxRestrictedGrant,
  type LinuxBackendDependencies,
  type LocalOperationBackend,
} from "./linux-operation-backend.js";
import { DEVICE_PROCESS_TOKEN, linuxOperationWorker } from "./linux-operation-worker.js";
import {
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

/** What the Docker executor lends one operation: its running container, held until release. */
export interface OperationContainerHost {
  operationContainer(
    signal: AbortSignal,
  ): Promise<{ name: string; user: string; release: () => void }>;
}

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
 * Agents in the device's local container: one `docker exec` per operation as the container user,
 * from the root-owned runtime the executor staged and verified. The container stays held (never
 * recreated) while the agent runs; the end of the exec's stdin tells the agent the device was lost.
 */
export function dockerLinuxTransport(host: OperationContainerHost): LinuxAgentTransport {
  const bundle = linuxRuntimeBundle();
  return {
    kind: "docker",
    expect: bundle.expect,
    spawn: async () => {
      const container = await host.operationContainer(new AbortController().signal);
      try {
        const child = spawn(
          "docker",
          [
            "exec",
            "-i",
            "-u",
            container.user,
            container.name,
            "python3",
            "-I",
            `${OPERATION_RUNTIME_DIR}/device-agent.py`,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        child.once("close", container.release);
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
  dependencies: Omit<LinuxBackendDependencies, "transport" | "baseEnv"> = {},
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
    linuxOperationWorker({ transport, baseEnv: containerBaseEnv, acquireRuntime: acquire });
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
      fullAccess: true,
      background: true,
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
