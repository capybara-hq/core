import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { SANDBOX_RUNTIME_SOURCE, SandboxPermissionUnsupportedError } from "@capybara-hq/plugin-sdk";

/** The owner's private `operation-runtime` directory inside the state directory. */
async function privateRuntimeDir(stateDir: string): Promise<{ dir: string; uid: number }> {
  const base = await realpath(stateDir);
  const info = await lstat(stateDir);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error("Runtime state directory must be private and owner controlled");
  const dir = join(base, "operation-runtime");
  await mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== info.uid)
    throw new Error("Unsafe runtime staging directory");
  return { dir, uid: info.uid };
}

/** Stage only bundled, hash-checked bytes in the owner's private state directory. */
export async function stagePrivateSource(
  stateDir: string,
  name: string,
  source: string,
): Promise<string> {
  const { dir, uid } = await privateRuntimeDir(stateDir);
  const hash = createHash("sha256").update(source).digest("hex");
  const path = join(dir, `${hash}-${name}`);
  let file: FileHandle | undefined;
  try {
    file = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await file.writeFile(source);
    await file.sync();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    await file?.close();
  }
  const checked = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await checked.stat();
    if (
      !s.isFile() ||
      s.uid !== uid ||
      (s.mode & 0o077) !== 0 ||
      createHash("sha256")
        .update(await checked.readFile())
        .digest("hex") !== hash
    )
      throw new Error("Runtime source identity mismatch");
  } finally {
    await checked.close();
  }
  return path;
}
export async function stageRuntimeSource(stateDir: string): Promise<string> {
  // Bundle 2 added the Linux launcher next to the native helper; this device stages only the helper.
  if (SANDBOX_RUNTIME_SOURCE.version !== 2) throw new Error("Unsupported runtime bundle");
  const file = SANDBOX_RUNTIME_SOURCE.files.find((f) => f.name === "native-files.py");
  if (!file || createHash("sha256").update(file.source).digest("hex") !== file.sha256)
    throw new Error("Runtime source hash mismatch");
  return stagePrivateSource(stateDir, file.name, file.source);
}

/**
 * Verify-to-launch pinning of the sandbox runtime closure (permission runtime cutover B-7).
 *
 * Verification (`verifyInstalledRuntime` with `stageIn`) copies the exact bytes it hashed into a
 * private, content-addressed directory of the state directory and seals that copy in this
 * process. A restricted worker imports the runtime only from the sealed copy
 * ({@link sealedRuntimeEntry}), so bytes changed in the install after verification are never
 * executed. Every launch also checks, cheaply by file identity, that the installed closure still
 * holds the verified bytes (a changed identity is hashed again) and that the staged copy is
 * untouched; otherwise it is refused, because the attested runtime identity no longer describes
 * the install. Recovery is a new verification: a restart or a rebind.
 */
export const fileIdentity = (s: BigIntStats) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mode}:${s.mtimeNs}:${s.ctimeNs}`;
/** One verified installed file: where it was, its identity when hashed, and its bytes. */
export interface InstalledFileRecord {
  path: string;
  identity: string;
  size: number;
  sha256: string;
}
/** One walked installed package directory: its identity and its entries (nested node_modules apart). */
export interface InstalledDirRecord {
  path: string;
  identity: string;
  names: string[];
}
interface RuntimeSeal {
  runtimeHash: string;
  closure: string;
  entry: string;
  staged: Map<string, string>;
  files: InstalledFileRecord[];
  dirs: InstalledDirRecord[];
}
let seal: RuntimeSeal | undefined;

const packageName = (id: string) => id.slice(0, id.lastIndexOf("@"));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Everything under `root`, by relative path: type, identity and (for a link) its target. */
async function walkIdentities(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const visit = async (path: string) => {
    const s = await lstat(path, { bigint: true });
    const rel = relative(root, path) || ".";
    if (s.isSymbolicLink()) out.set(rel, `link:${fileIdentity(s)}:${await readlink(path)}`);
    else if (s.isFile()) out.set(rel, `file:${fileIdentity(s)}`);
    else if (s.isDirectory()) {
      out.set(rel, `dir:${fileIdentity(s)}`);
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else out.set(rel, "other");
  };
  await visit(root);
  return out;
}

/**
 * Writes one verification's runtime closure into a private temporary directory as a package
 * store (`store/<id>/node_modules/<name>`, each dependency a relative link to its own store
 * entry, so Node resolves each package's verified dependency from inside the copy), then seals it.
 */
export class ClosureStager {
  private readonly written = new Map<string, string>();
  private readonly links = new Set<string>();
  private constructor(
    private readonly base: string,
    private readonly tmp: string,
    private readonly previous: string | undefined,
  ) {}

  /** Clears this process's seal first: a verification that does not finish leaves none. */
  static async begin(stateDir: string): Promise<ClosureStager> {
    const previous = seal?.closure;
    seal = undefined;
    const { dir } = await privateRuntimeDir(stateDir);
    const tmp = join(dir, `closure-tmp-${randomUUID()}`);
    await mkdir(tmp, { mode: 0o700 });
    return new ClosureStager(dir, tmp, previous);
  }

  private modulesDir(id: string): string {
    return join(this.tmp, "store", id.replaceAll("/", "+"), "node_modules");
  }
  private packageDir(id: string): string {
    return join(this.modulesDir(id), packageName(id));
  }

  /** One verified file: the exact bytes that were hashed, never read again from the install. */
  async file(id: string, rel: string, bytes: Uint8Array, executable: boolean): Promise<void> {
    const path = join(this.packageDir(id), rel);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      executable ? 0o500 : 0o400,
    );
    try {
      await file.writeFile(bytes);
      this.written.set(
        relative(this.tmp, path),
        `file:${fileIdentity(await file.stat({ bigint: true }))}`,
      );
    } finally {
      await file.close();
    }
  }

  /** `from` resolved its dependency `name` to the package `to` at verification. */
  async dependency(from: string, name: string, to: string): Promise<void> {
    if (packageName(from) === name) {
      if (from !== to) throw new Error(`${from} depends on another copy of itself (${to})`);
      return;
    }
    const link = join(this.modulesDir(from), name);
    if (this.links.has(link)) return;
    this.links.add(link);
    await mkdir(dirname(link), { recursive: true, mode: 0o700 });
    await symlink(relative(dirname(link), this.packageDir(to)), link);
  }

  async abort(): Promise<void> {
    await rm(this.tmp, { recursive: true, force: true });
  }

  /**
   * Moves the copy to its content-addressed place, checks that every file is still the one this
   * verification wrote, seals it with the installed identities, and prunes older copies (all but
   * the previous seal's, which a worker launched just before may still be loading).
   */
  async commit(input: {
    runtimeHash: string;
    entry: { id: string; rel: string };
    files: InstalledFileRecord[];
    dirs: InstalledDirRecord[];
  }): Promise<void> {
    const name = `closure-${input.runtimeHash}-${randomUUID().slice(0, 8)}`;
    const closure = join(this.base, name);
    await rename(this.tmp, closure);
    const staged = await walkIdentities(closure);
    for (const [rel, identity] of this.written)
      if (staged.get(rel) !== identity)
        throw new Error(`The staged runtime copy changed while it was written (${rel})`);
    const entry = join(
      closure,
      relative(this.tmp, join(this.packageDir(input.entry.id), input.entry.rel)),
    );
    if (!staged.get(relative(closure, entry))?.startsWith("file:"))
      throw new Error("The staged runtime has no entry module");
    for (const old of await readdir(this.base))
      if (old.startsWith("closure-") && old !== name && join(this.base, old) !== this.previous)
        await rm(join(this.base, old), { recursive: true, force: true });
    seal = {
      runtimeHash: input.runtimeHash,
      closure,
      entry,
      staged,
      files: input.files,
      dirs: input.dirs,
    };
  }
}

/** The first way the installed closure no longer holds the verified bytes, if any. */
async function installedDrift(s: RuntimeSeal): Promise<string | undefined> {
  const problems = await Promise.all([
    ...s.files.map(async (f) => {
      const now = await lstat(f.path, { bigint: true }).catch(() => undefined);
      if (!now) return `missing ${f.path}`;
      if (!now.isFile()) return `${f.path} is no longer a regular file`;
      if (fileIdentity(now) === f.identity) return undefined;
      // a new identity (rewritten, replaced): the bytes decide
      const file = await open(f.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
        () => undefined,
      );
      if (!file) return `${f.path} is no longer a regular file`;
      try {
        const bytes = await file.readFile();
        return bytes.byteLength === f.size && sha256(bytes) === f.sha256
          ? undefined
          : `changed ${f.path}`;
      } finally {
        await file.close();
      }
    }),
    ...s.dirs.map(async (d) => {
      const now = await lstat(d.path, { bigint: true }).catch(() => undefined);
      if (!now?.isDirectory()) return `${d.path} is no longer a directory`;
      if (fileIdentity(now) === d.identity) return undefined;
      const names = (await readdir(d.path)).filter((n) => n !== "node_modules").sort();
      const added = names.find((n) => !d.names.includes(n));
      if (added) return `unexpected ${join(d.path, added)}`;
      const gone = d.names.find((n) => !names.includes(n));
      return gone ? `missing ${join(d.path, gone)}` : undefined;
    }),
  ]);
  return problems.find((p) => p !== undefined);
}

/** The first difference between the staged copy and what was sealed, if any. */
async function stagedDrift(s: RuntimeSeal): Promise<string | undefined> {
  const now = await walkIdentities(s.closure).catch(() => undefined);
  if (!now) return "the staged copy is gone";
  for (const [rel, identity] of s.staged)
    if (now.get(rel) !== identity) return `the staged copy changed at ${rel}`;
  for (const rel of now.keys()) if (!s.staged.has(rel)) return `the staged copy gained ${rel}`;
  return undefined;
}

/**
 * The module a restricted worker imports the sandbox runtime from: the sealed private copy of
 * this process's last successful verification. Refused (typed unsupported, nothing launched)
 * when nothing was verified, when the installed closure no longer holds the verified bytes, or
 * when the staged copy changed.
 */
export async function sealedRuntimeEntry(): Promise<string> {
  const s = seal;
  if (!s)
    throw new SandboxPermissionUnsupportedError(
      "The sandbox runtime has not been verified in this process; rebind the instance or restart capybara-device so it verifies the runtime",
    );
  const problem = (await installedDrift(s)) ?? (await stagedDrift(s));
  if (problem)
    throw new SandboxPermissionUnsupportedError(
      `The sandbox runtime changed after it was verified (${problem}); restart capybara-device (or rebind the instance) so it verifies the runtime again, and reinstall capybara-device if verification fails`,
    );
  return s.entry;
}
