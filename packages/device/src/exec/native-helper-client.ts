import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { fstatSync } from "node:fs";
import type { Readable } from "node:stream";
import {
  nativeFailureText,
  SANDBOX_RUNTIME_SOURCE,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { type HelperLauncher, helperGone } from "./helper-launcher.js";
import { recordTransferTiming, timed } from "./transfer-timing.js";
export interface PinnedNativeRoot {
  path: string;
  fd: number;
  access: "read" | "write";
  /** Trusted components from the pinned ancestor to this exact logical root. */
  components?: readonly string[];
  /**
   * A read root that is a single existing file (a kernel read's `AGENTS.md`): `fd` is its parent
   * directory, and the helper reaches only that one name through it.
   */
  file?: true;
}
export interface NativeHelperRequest {
  method: "readFile" | "writeFile" | "stat" | "list" | "scan";
  path: string;
  maxBytes?: number;
  limit?: number;
  dataB64?: string;
}
export type NativeHelperResult =
  | null
  | { dataB64: string; truncated: boolean }
  | { size: number; isDir: boolean }
  | { entries: { name: string; isDir: boolean }[]; truncated: boolean }
  | { path: string; suggestedName: string }[];
export interface NativeHelperLaunch {
  pythonPath: string;
  helperPath: string;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  beforeDispatch?: () => Promise<void>;
  onLaunch?: (pid: number) => Promise<void>;
  onDiagnostic?: (text: string) => void;
}
// The pinned SDK source remains unchanged. This fixed transport only establishes its exact
// directory roots; the ancestor descriptor never becomes a NativeFiles data grant.
/** The native helper by name: the bundle also carries the Linux launcher, so order is not relied on. */
const NATIVE_FILES_SOURCE =
  SANDBOX_RUNTIME_SOURCE.current.find((file) => file.name === "native-files.py")?.source ?? "";

/** The handshake of a host helper: descriptor 3 and the pinned root descriptors from 4 on. */
const PRELUDE_HEAD = String.raw`
import os,json,sys,errno
expected=json.loads(sys.argv[2])
actual=[[os.fstat(fd).st_dev,os.fstat(fd).st_ino] for fd in range(4,4+len(expected))]
assert actual==expected, 'descriptor identity'
os.write(3,b'ready\n')
os.close(3)
`;
/** Loads the pinned SDK source (argv[1]) as a module namespace. */
const PRELUDE_SOURCE = String.raw`source={"__name__":"capybara_native"}
exec(compile(sys.argv[1],'<capybara-native>','exec'),source)
`;
/** NativeFiles anchored on trusted root components (shared by the host and container helpers). */
const PRELUDE_ANCHORED = String.raw`class AnchoredFiles(source["NativeFiles"]):
    def resolve(self,path,write,create,links,must_exist):
        if not source["valid_path"](path):
            raise ValueError("Supply a valid absolute native path")
        path=os.path.normpath(path)
        candidates=self.roots["write"] if write else self.roots["read"]+self.roots["write"]
        matches=[root for root in candidates if source["within"](root["path"],path)]
        if not matches:
            raise source["ScopeDenied"]("Native path is outside the supplied roots")
        root=max(matches,key=lambda entry:len(entry["path"]))
        components=root.get("components",[])
        if not components:
            return super().resolve(path,write,create,links,must_exist)
        original=root["fd"]
        fd=os.dup(original)
        try:
            for name in components:
                if not isinstance(name,str) or name in ("",".","..") or "/" in name or "\\" in name:
                    raise ValueError("Invalid trusted root component")
                try:
                    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                except FileNotFoundError:
                    if not (write and create):
                        raise
                    try:
                        os.mkdir(name,0o755,dir_fd=fd)
                    except FileExistsError:
                        pass
                    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                os.close(fd)
                fd=child
            root["fd"]=fd
            root["components"]=[]
            return super().resolve(path,write,create,links,must_exist)
        finally:
            root["fd"]=original
            root["components"]=components
            os.close(fd)
`;
const PRELUDE_TAIL = String.raw`try:
    request=json.load(sys.stdin)
    response={"result":AnchoredFiles(request["roots"]).run(request)}
except Exception as error:
    code=("SCOPE_DENIED" if isinstance(error,source["ScopeDenied"])
          else "NOT_REGULAR_FILE" if isinstance(error,ValueError) and str(error).endswith("require a regular file")
          else errno.errorcode.get(getattr(error,"errno",None),"INVALID_NATIVE_REQUEST"))
    response={"error":{"code":code,"message":"Native operation failed; check the path, scope and filesystem access"}}
print(json.dumps(response),flush=True)
`;
export const PRELUDE = PRELUDE_HEAD + PRELUDE_SOURCE + PRELUDE_ANCHORED + PRELUDE_TAIL;
/**
 * The native helper in a helper container (a docker-mode device's skills preparation): no
 * descriptor can cross into the container, so it opens each root's trusted anchor itself, walking
 * from "/" without following a link at any component (the container mounts only the step's host
 * paths, at the same absolute paths), and checks it against the host's identity of that anchor
 * where the mount preserves it (Linux). It reports "ready" on stdout, then reads one request line.
 */
export const CONTAINER_PRELUDE =
  String.raw`
import os,json,sys,errno
` +
  PRELUDE_SOURCE +
  String.raw`def anchor(path,expected):
    if not isinstance(path,str) or not path.startswith('/'):
        raise ValueError('Invalid anchor')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for name in path.split('/')[1:]:
            if name in ('','.','..') or '\\' in name:
                raise ValueError('Invalid anchor component')
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd)
            fd=child
        if expected is not None:
            s=os.fstat(fd)
            if [s.st_dev,s.st_ino]!=expected:
                raise source["ScopeDenied"]("Anchor identity changed")
        return fd
    except:
        os.close(fd)
        raise
print('ready',flush=True)
` +
  PRELUDE_ANCHORED +
  String.raw`try:
    request=json.loads(sys.stdin.readline())
    for kind in ("read","write"):
        for root in request["roots"][kind]:
            root["fd"]=anchor(root.pop("anchor"),root.pop("identity",None))
    response={"result":AnchoredFiles(request["roots"]).run(request)}
except Exception as error:
    code=("SCOPE_DENIED" if isinstance(error,source["ScopeDenied"])
          else "NOT_REGULAR_FILE" if isinstance(error,ValueError) and str(error).endswith("require a regular file")
          else errno.errorcode.get(getattr(error,"errno",None),"INVALID_NATIVE_REQUEST"))
    response={"error":{"code":code,"message":"Native operation failed; check the path, scope and filesystem access"}}
print(json.dumps(response),flush=True)
`;

export function nativeHelperInvocation(
  roots: readonly PinnedNativeRoot[],
  launch: Pick<NativeHelperLaunch, "pythonPath" | "helperPath">,
): { command: string; args: string[] } {
  const expected = roots.map((r) => {
    const s = fstatSync(r.fd);
    if (!s.isDirectory()) throw new Error("Pinned root must be a directory");
    return [s.dev, s.ino];
  });
  return {
    command: launch.pythonPath,
    args: ["-I", "-c", PRELUDE, NATIVE_FILES_SOURCE, JSON.stringify(expected)],
  };
}
type MappedRoot = { path: string; fd: number; components?: readonly string[]; file?: true };
/** Fixed helper only. Descriptor 3 is a private handshake, never command stdout. */
export async function runNativeHelper(
  request: NativeHelperRequest,
  roots: readonly PinnedNativeRoot[],
  launch: NativeHelperLaunch,
  signal: AbortSignal,
): Promise<NativeHelperResult> {
  signal.throwIfAborted();
  const expected = roots.map((r) => {
    const s = fstatSync(r.fd);
    if (!s.isDirectory()) throw new Error("Pinned root must be a directory");
    return [s.dev, s.ino];
  });
  const spawnedAt = performance.now();
  let dispatchedAt = 0;
  const child = (launch.spawn ?? spawn)(
    launch.pythonPath,
    ["-I", "-c", PRELUDE, NATIVE_FILES_SOURCE, JSON.stringify(expected)],
    { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe", ...roots.map((r) => r.fd)] },
  );
  let bytes = 0;
  let stderrBytes = 0;
  const chunks: Buffer[] = [];
  let ready = false;
  let failure: unknown;
  let handshake = "";
  let killSent = false;
  const kill = () => {
    if (killSent) return;
    killSent = true;
    if (child.pid)
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH" && failure === undefined) failure = e;
      }
  };
  const abort = () => kill();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) kill();
  const cap = Math.min(24 * 1024 * 1024, Math.max(1024 * 1024, (request.maxBytes ?? 0) * 2 + 4096));
  const timer = setTimeout(() => {
    failure = new SandboxPermissionUnsupportedError(
      "Native helper descriptor handshake or operation timed out",
    );
    kill();
  }, 30000);
  child.stdin?.on("error", () => {});
  child.stdout?.on("data", (b: Buffer) => {
    bytes += b.length;
    if (bytes > cap) {
      failure = new Error("Native helper response exceeds the bounded transport");
      kill();
    } else chunks.push(b);
  });
  child.stderr?.on("data", (b: Buffer) => {
    stderrBytes += b.length;
    if (stderrBytes <= 65536) launch.onDiagnostic?.(b.toString());
    if (stderrBytes > 65536) {
      failure = new Error("Native helper stderr exceeds the bounded transport");
      kill();
    }
  });
  const launched = child.pid
    ? (launch.onLaunch?.(child.pid) ?? Promise.resolve())
    : Promise.reject(new Error("Helper launch has no identity"));
  void launched.catch(() => {});
  (child.stdio[3] as Readable | null)?.on("data", (b: Buffer) => {
    handshake += b.toString();
    if (handshake.length > 32) {
      failure = new SandboxPermissionUnsupportedError("Invalid descriptor handshake");
      kill();
      return;
    }
    if (handshake === "ready\n" && !ready) {
      ready = true;
      recordTransferTiming(request.method, "spawn", performance.now() - spawnedAt);
      void (async () => {
        try {
          await launched;
          await launch.beforeDispatch?.();
          signal.throwIfAborted();
          const mapped = {
            read: [] as MappedRoot[],
            write: [] as MappedRoot[],
          };
          roots.forEach((r, i) => {
            mapped[r.access].push({
              path: r.path,
              fd: i + 4,
              ...(r.components ? { components: r.components } : {}),
              ...(r.file ? { file: true as const } : {}),
            });
          });
          const body = timed(request.method, "serialise", () =>
            JSON.stringify({ ...request, roots: mapped }),
          );
          dispatchedAt = performance.now();
          child.stdin?.end(body);
        } catch (e) {
          failure = e;
          kill();
        }
      })();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    await launched;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    kill();
  }
  if (dispatchedAt)
    recordTransferTiming(request.method, "helperIo", performance.now() - dispatchedAt);
  signal.throwIfAborted();
  if (failure) throw failure;
  if (!ready)
    throw new SandboxPermissionUnsupportedError(
      "Native helper descriptor handshake failed; pathname reopening is forbidden",
    );
  let response: { result?: NativeHelperResult; error?: { code: string; message: string } };
  try {
    response = timed(request.method, "parse", () =>
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
  } catch {
    throw new Error("Native helper returned invalid bounded JSON");
  }
  if (response.error) {
    if (["SCOPE_DENIED", "EACCES", "EPERM", "ELOOP"].includes(response.error.code))
      throw new SandboxScopeDeniedError(response.error.message);
    throw new Error(nativeFailureText(response.error.code));
  }
  if (!Object.hasOwn(response, "result")) throw new Error("Native helper omitted result");
  return response.result ?? null;
}

/** One root of a container native helper: the trusted anchor it opens and the host's identity. */
export interface ContainerNativeRoot {
  path: string;
  access: "read" | "write";
  /** The directory the helper opens no-follow from "/" (inside the step's mounts). */
  anchor: string;
  /** The anchor's `[dev, ino]` as the host saw it, where the mount preserves it; else null. */
  identity: [number, number] | null;
  components?: readonly string[];
}

/** What a container native helper runs with. */
export interface ContainerNativeLaunch {
  launcher: HelperLauncher;
  /** The host paths the helper container mounts (the device's skills directory). */
  paths: readonly string[];
  beforeDispatch?: () => Promise<void>;
  onLaunch?: (pid: number) => Promise<void>;
  onDiagnostic?: (text: string) => void;
}

/**
 * The fixed native helper in a helper container: the same NativeFiles source and anchored roots
 * as {@link runNativeHelper}, with the roots opened inside the container ({@link CONTAINER_PRELUDE})
 * instead of passed as descriptors. Its first stdout line is the handshake; the request is sent
 * only after `beforeDispatch`, and the next line is the bounded response.
 */
export async function runContainerNativeHelper(
  request: NativeHelperRequest,
  roots: readonly ContainerNativeRoot[],
  launch: ContainerNativeLaunch,
  signal: AbortSignal,
): Promise<NativeHelperResult> {
  signal.throwIfAborted();
  const spawnedAt = performance.now();
  let dispatchedAt = 0;
  const child = launch.launcher.spawn(CONTAINER_PRELUDE, [NATIVE_FILES_SOURCE], launch.paths);
  let bytes = 0;
  let stderrBytes = 0;
  let stderrHead = "";
  let pending = "";
  let ready = false;
  let response: string | undefined;
  let failure: unknown;
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    child.kill("SIGKILL");
  };
  const abort = () => kill();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) kill();
  const cap = Math.min(24 * 1024 * 1024, Math.max(1024 * 1024, (request.maxBytes ?? 0) * 2 + 4096));
  // a helper container start pulls nothing (the image is the device container's) but is slower
  // than a local process: the same bound as the host helper, plus a container start
  const timer = setTimeout(() => {
    failure = new SandboxPermissionUnsupportedError("Native helper container timed out");
    kill();
  }, 60000);
  child.stdin.on("error", () => {});
  const launched = child.pid
    ? (launch.onLaunch?.(child.pid) ?? Promise.resolve())
    : Promise.reject(new Error("Helper launch has no identity"));
  void launched.catch(() => {});
  const dispatch = async () => {
    try {
      await launched;
      await launch.beforeDispatch?.();
      signal.throwIfAborted();
      const mapped = { read: [] as object[], write: [] as object[] };
      for (const r of roots)
        mapped[r.access].push({
          path: r.path,
          anchor: r.anchor,
          identity: r.identity,
          ...(r.components ? { components: r.components } : {}),
        });
      const body = timed(request.method, "serialise", () =>
        JSON.stringify({ ...request, roots: mapped }),
      );
      dispatchedAt = performance.now();
      child.stdin.end(`${body}\n`);
    } catch (e) {
      failure = e;
      kill();
    }
  };
  child.stdout.on("data", (b: Buffer) => {
    bytes += b.length;
    if (bytes > cap) {
      failure = new Error("Native helper response exceeds the bounded transport");
      kill();
      return;
    }
    pending += b.toString("utf8");
    for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (!ready) {
        if (line !== "ready") {
          failure = new SandboxPermissionUnsupportedError("Invalid native helper handshake");
          kill();
          return;
        }
        ready = true;
        recordTransferTiming(request.method, "spawn", performance.now() - spawnedAt);
        void dispatch();
      } else if (response === undefined) response = line;
    }
  });
  child.stderr.on("data", (b: Buffer) => {
    stderrBytes += b.length;
    if (stderrHead.length < 300) stderrHead += b.toString();
    if (stderrBytes <= 65536) launch.onDiagnostic?.(b.toString());
    if (stderrBytes > 65536) {
      failure = new Error("Native helper stderr exceeds the bounded transport");
      kill();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    await launched;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    // a cancelled helper settles only once its container is gone, so no write follows the cancel
    await helperGone(child);
  }
  if (dispatchedAt)
    recordTransferTiming(request.method, "helperIo", performance.now() - dispatchedAt);
  signal.throwIfAborted();
  if (failure) throw failure;
  if (!ready)
    throw new SandboxPermissionUnsupportedError(
      `Native helper container did not start${stderrHead ? `: ${stderrHead.trim().split("\n")[0]?.slice(0, 200)}` : ""}`,
    );
  let parsed: { result?: NativeHelperResult; error?: { code: string; message: string } };
  try {
    parsed = timed(request.method, "parse", () => JSON.parse(response ?? ""));
  } catch {
    throw new Error("Native helper returned invalid bounded JSON");
  }
  if (parsed.error) {
    if (["SCOPE_DENIED", "EACCES", "EPERM", "ELOOP"].includes(parsed.error.code))
      throw new SandboxScopeDeniedError(parsed.error.message);
    throw new Error(nativeFailureText(parsed.error.code));
  }
  if (!Object.hasOwn(parsed, "result")) throw new Error("Native helper omitted result");
  return parsed.result ?? null;
}
