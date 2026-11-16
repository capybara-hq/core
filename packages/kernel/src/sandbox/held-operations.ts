import {
  type ExecResult,
  type SandboxExecOptions,
  type SandboxExecutionRef,
  type SandboxHandle,
  type SandboxOperationScope,
  SandboxPermissionUnsupportedError,
  type SandboxProvider,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { assertManagedArtifactAdmitted } from "../background/launch.js";

/** A callback can use native operations; it cannot obtain a new authority or change lifecycle. */
export type HeldProvider = Pick<
  SandboxProvider,
  "readFile" | "writeFile" | "stat" | "list" | "scan"
> & {
  exec(
    h: SandboxHandle,
    args: Omit<Parameters<SandboxProvider["exec"]>[1], "tag" | "actor">,
  ): Promise<ExecResult>;
  /**
   * A managed background start (dormant until the paired activation): admitted, persisted and
   * acknowledged by the service under the same stable operation identity. Present only on the
   * operation-held provider; the protocol-2 adapter has none.
   */
  backgroundStart?(h: SandboxHandle, args: ManagedStartArgs): Promise<SandboxExecutionRef>;
};
/** A managed start's input: hashed as the stable start input (without the signal). */
export type ManagedStartArgs = SandboxExecOptions & {
  /** The trusted working root; the artifact is placed under it. */
  cwd: string;
  taskId: string;
  outputPath: string;
  retainUntilMs: number;
};
export type NativeMethod = "exec" | "readFile" | "writeFile" | "stat" | "list" | "scan";
export type OperationMethod = NativeMethod | "backgroundStart";
/** The service admits and claims durably before invoking this closure inline under its lease. */
export type OperationDispatch = <T>(
  method: OperationMethod,
  input: unknown,
  invoke: (scope: SandboxOperationScope, signal: AbortSignal) => Promise<T>,
) => Promise<T>;

export function createHeldOperations(
  provider: SandboxProvider,
  handle: SandboxHandle,
  heldSignal: AbortSignal,
  dispatch: OperationDispatch,
): HeldProvider {
  const call = <T>(
    h: SandboxHandle,
    method: OperationMethod,
    input: unknown,
    signal: AbortSignal,
    invoke: (
      op: Awaited<ReturnType<NonNullable<SandboxProvider["operation"]>>> | null,
      signal: AbortSignal,
      scope: SandboxOperationScope,
    ) => Promise<T>,
  ): Promise<T> => {
    if (h.id !== handle.id) throw new SandboxScopeDeniedError("Use the currently held instance");
    const combined = signal === heldSignal ? signal : AbortSignal.any([signal, heldSignal]);
    combined.throwIfAborted();
    return dispatch(method, input, async (scope, admittedSignal) => {
      const sig =
        admittedSignal === combined ? combined : AbortSignal.any([combined, admittedSignal]);
      sig.throwIfAborted();
      if (!provider.operation || !provider.permissionSupport || !provider.revokeOperation)
        throw new SandboxPermissionUnsupportedError(
          "This provider does not support permission operations",
        );
      const support = await provider.permissionSupport(handle, sig);
      if (
        support.version !== 1 ||
        (method === "backgroundStart" && (!support.background || !provider.background)) ||
        (scope.profile === "full-access"
          ? !support.fullAccess
          : !support.restricted?.filesystem ||
            !support.restricted.network ||
            !support.restricted.native ||
            !support.restricted.concurrentScopes)
      )
        throw new SandboxPermissionUnsupportedError(
          support.unavailableReason ?? "This runtime cannot enforce the selected permissions",
        );
      sig.throwIfAborted();
      // A background start has no operation object: the provider owns it by exact identity.
      if (method === "backgroundStart") return invoke(null, sig, scope);
      const op = await provider.operation(handle, scope, sig);
      return invoke(op, sig, scope);
    });
  };
  const native = (
    op: Awaited<ReturnType<NonNullable<SandboxProvider["operation"]>>> | null,
  ): NonNullable<typeof op> => {
    if (!op) throw new SandboxPermissionUnsupportedError("Native operation is unavailable");
    return op;
  };
  return {
    exec(h, args) {
      const { signal, ...given } = args;
      const input = structuredClone(given);
      return call(h, "exec", input, signal, (op, sig) =>
        native(op).exec({ ...input, signal: sig }),
      );
    },
    readFile(h, path, opts) {
      const { maxBytes, signal } = opts;
      return call(h, "readFile", { path, maxBytes }, signal, (op, sig) =>
        native(op).readFile(path, { maxBytes, signal: sig }),
      );
    },
    writeFile(h, path, data, signal) {
      const copy = new Uint8Array(data);
      return call(h, "writeFile", { path, data: copy }, signal, (op, sig) =>
        native(op).writeFile(path, copy, sig),
      );
    },
    stat(h, path, signal) {
      return call(h, "stat", { path }, signal, (op, sig) => native(op).stat(path, sig));
    },
    ...(provider.list && provider.scan
      ? ({
          list: (h, path, opts) => {
            const { limit, signal } = opts;
            return call(h, "list", { path, limit }, signal, (o, sig) => {
              const op = native(o);
              if (!op.list)
                throw new SandboxPermissionUnsupportedError("Native listing is unavailable");
              return op.list(path, { limit, signal: sig });
            });
          },
          scan: (h, base, opts) =>
            call(h, "scan", { base }, opts.signal, (o, sig) => {
              const op = native(o);
              if (!op.scan)
                throw new SandboxPermissionUnsupportedError("Native scanning is unavailable");
              return op.scan(base, { signal: sig });
            }),
        } satisfies Pick<HeldProvider, "list" | "scan">)
      : {}),
    // Only a provider with exact background ownership offers a start; none falls back to exec.
    ...(provider.background
      ? ({
          backgroundStart: (h, args) => {
            const { signal, ...given } = args;
            const input = structuredClone(given);
            return call(h, "backgroundStart", input, signal, (_op, sig, scope) => {
              // Pre-effect: the artifact must already be covered by the admitted starting authority.
              assertManagedArtifactAdmitted(scope, input);
              const background = provider.background;
              if (!background)
                throw new SandboxPermissionUnsupportedError(
                  "Managed background tasks are unavailable",
                );
              return background.start(handle, scope, { ...input, signal: sig });
            });
          },
        } satisfies Pick<HeldProvider, "backgroundStart">)
      : {}),
  };
}

/** Temporary v2 callback adapter. Removed with the coordinated Task 8 cutover. */
export function createLegacyHeldProvider(
  provider: SandboxProvider,
  tag: string,
  actor: Parameters<SandboxProvider["exec"]>[1]["actor"],
  before: () => Promise<void>,
): HeldProvider {
  return {
    exec: async (h, args) => {
      await before();
      return provider.exec(h, { ...args, tag, actor });
    },
    readFile: provider.readFile.bind(provider),
    writeFile: provider.writeFile.bind(provider),
    stat: provider.stat.bind(provider),
    ...(provider.list ? { list: provider.list.bind(provider) } : {}),
    ...(provider.scan ? { scan: provider.scan.bind(provider) } : {}),
  };
}
