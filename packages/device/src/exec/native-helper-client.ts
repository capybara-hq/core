import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { fstatSync } from "node:fs";
import type { Readable } from "node:stream";
import {
  SANDBOX_RUNTIME_SOURCE,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
export interface PinnedNativeRoot {
  path: string;
  fd: number;
  access: "read" | "write";
  /** Trusted components from the pinned ancestor to this exact logical root. */
  components?: readonly string[];
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
  SANDBOX_RUNTIME_SOURCE.files.find((file) => file.name === "native-files.py")?.source ?? "";

const PRELUDE = String.raw`
import os,json,sys,errno
expected=json.loads(sys.argv[2])
actual=[[os.fstat(fd).st_dev,os.fstat(fd).st_ino] for fd in range(4,4+len(expected))]
assert actual==expected, 'descriptor identity'
os.write(3,b'ready\n')
os.close(3)
source={"__name__":"capybara_native"}
exec(compile(sys.argv[1],'<capybara-native>','exec'),source)
class AnchoredFiles(source["NativeFiles"]):
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
try:
    request=json.load(sys.stdin)
    response={"result":AnchoredFiles(request["roots"]).run(request)}
except Exception as error:
    code=("SCOPE_DENIED" if isinstance(error,source["ScopeDenied"])
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
      void (async () => {
        try {
          await launched;
          await launch.beforeDispatch?.();
          signal.throwIfAborted();
          const mapped = {
            read: [] as { path: string; fd: number; components?: readonly string[] }[],
            write: [] as { path: string; fd: number; components?: readonly string[] }[],
          };
          roots.forEach((r, i) => {
            mapped[r.access].push({
              path: r.path,
              fd: i + 4,
              ...(r.components ? { components: r.components } : {}),
            });
          });
          child.stdin?.end(JSON.stringify({ ...request, roots: mapped }));
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
  signal.throwIfAborted();
  if (failure) throw failure;
  if (!ready)
    throw new SandboxPermissionUnsupportedError(
      "Native helper descriptor handshake failed; pathname reopening is forbidden",
    );
  let response: { result?: NativeHelperResult; error?: { code: string; message: string } };
  try {
    response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Native helper returned invalid bounded JSON");
  }
  if (response.error) {
    if (["SCOPE_DENIED", "EACCES", "EPERM", "ELOOP"].includes(response.error.code))
      throw new SandboxScopeDeniedError(response.error.message);
    throw new Error(response.error.message);
  }
  if (!Object.hasOwn(response, "result")) throw new Error("Native helper omitted result");
  return response.result ?? null;
}
