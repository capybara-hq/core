import {
  type ExecResult,
  type SandboxHandle,
  type SandboxOperationScope,
  SandboxPermissionUnsupportedError,
  type SandboxProvider,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";

/** A callback can use native operations; it cannot obtain a new authority or change lifecycle. */
export type HeldProvider = Pick<
  SandboxProvider,
  "readFile" | "writeFile" | "stat" | "list" | "scan"
> & {
  exec(
    h: SandboxHandle,
    args: Omit<Parameters<SandboxProvider["exec"]>[1], "tag" | "actor">,
  ): Promise<ExecResult>;
};
export type NativeMethod = "exec" | "readFile" | "writeFile" | "stat" | "list" | "scan";
/** The service admits and claims durably before invoking this closure inline under its lease. */
export type OperationDispatch = <T>(
  method: NativeMethod,
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
    method: NativeMethod,
    input: unknown,
    signal: AbortSignal,
    invoke: (
      op: Awaited<ReturnType<NonNullable<SandboxProvider["operation"]>>>,
      signal: AbortSignal,
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
      const op = await provider.operation(handle, scope, sig);
      return invoke(op, sig);
    });
  };
  return {
    exec(h, args) {
      const { signal, ...given } = args;
      const input = structuredClone(given);
      return call(h, "exec", input, signal, (op, sig) => op.exec({ ...input, signal: sig }));
    },
    readFile(h, path, opts) {
      const { maxBytes, signal } = opts;
      return call(h, "readFile", { path, maxBytes }, signal, (op, sig) =>
        op.readFile(path, { maxBytes, signal: sig }),
      );
    },
    writeFile(h, path, data, signal) {
      const copy = new Uint8Array(data);
      return call(h, "writeFile", { path, data: copy }, signal, (op, sig) =>
        op.writeFile(path, copy, sig),
      );
    },
    stat(h, path, signal) {
      return call(h, "stat", { path }, signal, (op, sig) => op.stat(path, sig));
    },
    ...(provider.list && provider.scan
      ? ({
          list: (h, path, opts) => {
            const { limit, signal } = opts;
            return call(h, "list", { path, limit }, signal, (op, sig) => {
              if (!op.list)
                throw new SandboxPermissionUnsupportedError("Native listing is unavailable");
              return op.list(path, { limit, signal: sig });
            });
          },
          scan: (h, base, opts) =>
            call(h, "scan", { base }, opts.signal, (op, sig) => {
              if (!op.scan)
                throw new SandboxPermissionUnsupportedError("Native scanning is unavailable");
              return op.scan(base, { signal: sig });
            }),
        } satisfies Pick<HeldProvider, "list" | "scan">)
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
