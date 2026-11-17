import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, platform, release, version } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SANDBOX_RUNTIME_SOURCE } from "@capybara-hq/plugin-sdk";
import { LINUX_DEVICE_AGENT } from "./linux-agent.js";
import { PRELUDE } from "./native-helper-client.js";
import { WORKER } from "./operation-worker.js";
import { OUTPUT_SPOOL_HELPER } from "./output-spool-helper.js";
import {
  ClosureStager,
  fileIdentity,
  type InstalledDirRecord,
  type InstalledFileRecord,
} from "./runtime-source.js";

/**
 * Canonical installed-byte manifest, version 1 (permission runtime cutover B4). The package build
 * emits `dist/runtime-manifest.json` from the exact emitted/installed assets
 * (`tools/runtime-manifest.ts`); at bind time the device enumerates and hashes the installed bytes
 * again, from locations it resolves itself, and attests only when they equal the shipped
 * manifest. Nothing here is ever taken from a wire request.
 */
export type ManifestEntry = readonly [logicalName: string, byteLength: number, sha256: string];
export const MANIFEST_FILE = "runtime-manifest.json";
export interface ShippedManifest {
  version: 1;
  runtime: ManifestEntry[];
  helpers: ManifestEntry[];
}
export class RuntimeManifestError extends Error {
  override name = "RuntimeManifestError";
}

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const LOGICAL = /^[\x21-\x7e]+$/;

function checkEntries(entries: readonly ManifestEntry[]): ManifestEntry[] {
  const seen = new Set<string>();
  for (const e of entries) {
    if (!Array.isArray(e) || e.length !== 3) throw new RuntimeManifestError("Invalid entry arity");
    const [name, size, hash] = e;
    if (
      typeof name !== "string" ||
      !LOGICAL.test(name) ||
      name.startsWith("/") ||
      name.endsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((p) => p === "" || p === "." || p === "..")
    )
      throw new RuntimeManifestError(`Invalid logical name ${JSON.stringify(name)}`);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new RuntimeManifestError(`Invalid byte length for ${name}`);
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
      throw new RuntimeManifestError(`Invalid sha256 for ${name}`);
    if (seen.has(name)) throw new RuntimeManifestError(`Duplicate logical name ${name}`);
    seen.add(name);
  }
  // code-point order (ASCII names), never locale order
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
/** UTF-8 JSON of `[1, kind, sortedEntries]`, no whitespace. */
export function canonicalManifest(
  kind: "runtime" | "helpers",
  entries: readonly ManifestEntry[],
): string {
  return JSON.stringify([1, kind, checkEntries(entries)]);
}
export const manifestHash = (kind: "runtime" | "helpers", entries: readonly ManifestEntry[]) =>
  sha256(canonicalManifest(kind, entries));

export interface EnvironmentFacts {
  platform: string;
  arch: string;
  osBuild: string;
  effectiveUid: number;
  nodeRealPath: string;
  nodeSha256: string;
  nodeVersion: string;
  pythonRealPath: string;
  pythonSha256: string;
  pythonVersion: string;
  shellRealPath: string;
  shellSha256: string;
  providerImageDigest: string | null;
  interpreterLibraryEntries: ManifestEntry[];
  environmentBoundaryDigest: string;
}
export function canonicalEnvironment(f: EnvironmentFacts): string {
  return JSON.stringify([
    1,
    "environment",
    f.platform,
    f.arch,
    f.osBuild,
    f.effectiveUid,
    f.nodeRealPath,
    f.nodeSha256,
    f.nodeVersion,
    f.pythonRealPath,
    f.pythonSha256,
    f.pythonVersion,
    f.shellRealPath,
    f.shellSha256,
    f.providerImageDigest,
    checkEntries(f.interpreterLibraryEntries),
    f.environmentBoundaryDigest,
  ]);
}
export const environmentHash = (f: EnvironmentFacts) => sha256(canonicalEnvironment(f));

/**
 * The bytes of one regular file read through its opened handle (no symlink at the last
 * component, identity checked against the path after the read), so a swap or a write during
 * hashing fails. The identity is the one the bytes belong to.
 */
async function readRegularFile(path: string): Promise<{ bytes: Buffer; stat: BigIntStats }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((e) => {
    throw new RuntimeManifestError(`Cannot open ${path}: ${(e as Error).message}`);
  });
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new RuntimeManifestError(`${path} is not a regular file`);
    const bytes = await file.readFile();
    const after = await lstat(path, { bigint: true });
    if (
      !after.isFile() ||
      fileIdentity(after) !== fileIdentity(before) ||
      after.size !== BigInt(bytes.byteLength)
    )
      throw new RuntimeManifestError(`${path} changed while it was verified`);
    return { bytes, stat: before };
  } finally {
    await file.close();
  }
}
export async function hashRegularFile(path: string): Promise<{ size: number; sha256: string }> {
  const { bytes } = await readRegularFile(path);
  return { size: bytes.byteLength, sha256: sha256(bytes) };
}

const textEntry = (name: string, text: string): ManifestEntry => {
  const bytes = Buffer.from(text, "utf8");
  return [name, bytes.byteLength, sha256(bytes)];
};

/** Where the trusted closure starts; fixed for the shipped program, injectable for owned fixtures. */
export interface ManifestLayout {
  /** The device package root (holding `dist/`). */
  packageRoot: string;
  /** Emitted modules whose static import closure forms the helper set (package-relative). */
  helperModules: readonly string[];
  /** Packages whose installed files and dependency closure form the runtime set. */
  runtimePackages: readonly string[];
  /** Logical inline sources (constant strings executed by helpers), by logical name. */
  inline: Readonly<Record<string, string>>;
  /**
   * Known non-literal dynamic imports, by helper logical name: each exact expression must load
   * a runtime package (covered by the runtime entries). Any other one fails the enumeration.
   */
  dynamicImports?: Readonly<Record<string, readonly string[]>>;
}
const HELPER_MODULES = [
  "mac-operation-backend",
  "linux-operation-backend",
  "linux-operation-worker",
  "linux-runtime",
  "linux-agent",
  "docker-operations",
  "operation-supervisor",
  "operation-worker",
  "native-helper-client",
  "output-spool",
  "output-spool-helper",
  "runtime-source",
  "operation-types",
  "shared",
  "runtime-manifest",
].map((m) => `dist/exec/${m}.js`);

/** The shipped program's layout, resolved from this module's own installed location. */
export function installedLayout(): ManifestLayout {
  const here = fileURLToPath(import.meta.url);
  const native = SANDBOX_RUNTIME_SOURCE.files.find((f) => f.name === "native-files.py");
  if (!native || sha256(native.source) !== native.sha256)
    throw new RuntimeManifestError("Bundled native helper source does not match its hash");
  const linux = SANDBOX_RUNTIME_SOURCE.files.find((f) => f.name === "linux-sandbox.py");
  if (!linux || sha256(linux.source) !== linux.sha256)
    throw new RuntimeManifestError("Bundled Linux launcher source does not match its hash");
  return {
    packageRoot: resolve(dirname(here), "..", ".."),
    helperModules: HELPER_MODULES,
    runtimePackages: ["@anthropic-ai/sandbox-runtime"],
    inline: {
      "inline/native-files.py": native.source,
      "inline/native-helper-prelude.py": PRELUDE,
      "inline/output-spool-helper.py": OUTPUT_SPOOL_HELPER,
      "inline/mac-worker.mjs": WORKER,
      // the Linux backend stages these next to native-files.py (linux-runtime.ts)
      "inline/linux-sandbox.py": linux.source,
      "inline/linux-device-agent.py": LINUX_DEVICE_AGENT,
    },
    // the worker bootstrap loads the resolved @anthropic-ai/sandbox-runtime entry
    dynamicImports: {
      // spelled in two parts so this module's own source holds no dynamic import expression
      "package/dist/exec/operation-worker.js": [`${"import"}(pathToFileURL(message.runtime))`],
    },
  };
}

const STATIC_IMPORT =
  /(?:^|[;\s}])(?:import|export)\s*(?:[^'"`;]*?\sfrom\s*)?(["'])([^"'\n]+)\1|import\s*\(\s*(["'])([^"'\n]+)\3\s*\)/g;
const DYNAMIC_IMPORT = /import\s*\(/g;

/**
 * One pass over module text: `uncommented` drops comments (a commented import loads nothing) and
 * `code` also empties quoted strings (text that only mentions an import). Template literals stay
 * code: a template run as code elsewhere, like the worker bootstrap, must be declared. A quote
 * left open at the end of a line is refused rather than guessed.
 */
/** Whether a `/` after `before` starts a regular expression rather than dividing. */
function regexMayStart(before: string): boolean {
  const t = before.trimEnd();
  if (t === "") return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(t)) return true;
  return /(?:^|[^\w$.])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(
    t,
  );
}
function lex(source: string): { uncommented: string; code: string } {
  let uncommented = "",
    code = "",
    i = 0;
  // brace depths of open template substitutions; template text itself is kept verbatim (and so
  // still counted), only `${…}` is lexed as code
  const templates: number[] = [];
  let depth = 0;
  const copy = (text: string, asCode = text) => {
    uncommented += text;
    code += asCode;
  };
  const template = () => {
    // at a backtick or a closing `}` of a substitution: copy text up to the end or `${`
    let j = i + 1;
    for (; j < source.length; j++) {
      if (source[j] === "\\") j++;
      else if (source[j] === "`") {
        copy(source.slice(i, j + 1));
        i = j + 1;
        return;
      } else if (source[j] === "$" && source[j + 1] === "{") {
        copy(source.slice(i, j + 2));
        templates.push(depth);
        i = j + 2;
        return;
      }
    }
    throw new RuntimeManifestError(`Unterminated template at offset ${i}`);
  };
  while (i < source.length) {
    const c = source[i] as string,
      next = source[i + 1];
    if (c === "`") template();
    else if (c === "}" && templates.length && templates[templates.length - 1] === depth) {
      templates.pop();
      template();
    } else if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (c === "/" && regexMayStart(code)) {
      // a regular expression literal: copied whole (its quotes and slashes are not code)
      let j = i + 1,
        inClass = false;
      while (j < source.length && (source[j] !== "/" || inClass)) {
        if (source[j] === "\n")
          throw new RuntimeManifestError(`Unterminated regular expression at offset ${i}`);
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j += source[j] === "\\" ? 2 : 1;
      }
      copy(source.slice(i, j + 1), "/regex/");
      i = j + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === "\n")
          throw new RuntimeManifestError(`Unterminated string at offset ${i}`);
        j += source[j] === "\\" ? 2 : 1;
      }
      copy(source.slice(i, j + 1), '""');
      i = j + 1;
    } else {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      copy(c);
      i++;
    }
  }
  return { uncommented, code };
}

/** The specifiers a module imports; a dynamic import that is not a literal cannot be enumerated. */
export function moduleImports(
  source: string,
  name: string,
  known: readonly string[] = [],
): string[] {
  for (const expression of known) {
    if (!source.includes(expression))
      throw new RuntimeManifestError(`${name} no longer has its known import ${expression}`);
    source = source.split(expression).join("");
  }
  let lexed: ReturnType<typeof lex>;
  try {
    lexed = lex(source);
  } catch (e) {
    throw new RuntimeManifestError(`${name}: ${(e as Error).message}`);
  }
  const { uncommented, code } = lexed;
  const literal = [...uncommented.matchAll(STATIC_IMPORT)].map((m) => (m[2] ?? m[4]) as string);
  const dynamicLiteral = [...code.matchAll(/import\s*\(\s*""\s*\)/g)].length;
  if ([...code.matchAll(DYNAMIC_IMPORT)].length !== dynamicLiteral)
    throw new RuntimeManifestError(`${name} has a dynamic import that cannot be enumerated`);
  return literal;
}

async function packageRootOf(file: string): Promise<{ root: string; name: string }> {
  let dir = dirname(file);
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (typeof pkg.name === "string") return { root: dir, name: pkg.name };
    } catch {}
    const up = dirname(dir);
    if (up === dir) throw new RuntimeManifestError(`No package owns ${file}`);
    dir = up;
  }
}
const logical = (prefix: string, root: string, file: string) => {
  const rel = relative(root, file);
  if (rel.startsWith("..") || rel === "") throw new RuntimeManifestError(`${file} escapes ${root}`);
  return `${prefix}/${rel.split(sep).join("/")}`;
};

/**
 * Every regular file of a package (its own nested node_modules excluded); links are refused.
 * Each walked directory is recorded with an identity taken around its listing, so an entry added
 * while it is listed fails here, and one added later shows at launch.
 */
async function packageFiles(root: string, dirs: InstalledDirRecord[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    const before = await lstat(dir, { bigint: true });
    const entries = await readdir(dir, { withFileTypes: true });
    const after = await lstat(dir, { bigint: true });
    if (!after.isDirectory() || fileIdentity(after) !== fileIdentity(before))
      throw new RuntimeManifestError(`${dir} changed while it was verified`);
    dirs.push({
      path: dir,
      identity: fileIdentity(after),
      names: entries
        .map((e) => e.name)
        .filter((n) => n !== "node_modules")
        .sort(),
    });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") await walk(p);
      } else if (e.isFile()) out.push(p);
      else throw new RuntimeManifestError(`${p} is not a regular file`);
    }
  };
  await walk(root);
  return out;
}

/** What one enumeration saw, for staging and the launch-time identity checks. */
interface Observed {
  files: InstalledFileRecord[];
  dirs: InstalledDirRecord[];
  /** The first runtime package's entry module, as `[package id, package-relative path]`. */
  entry?: { id: string; rel: string };
  stager?: ClosureStager;
}

/**
 * The installed runtime and helper entries for `layout`, hashed from the files on disk. Helper
 * entries: the static import closure of the helper modules (into `@capybara-hq/*` packages), plus
 * the inline sources. Runtime entries: every file of each runtime package and its production
 * dependency closure, plus a version entry per package.
 */
export async function enumerateInstalled(
  layout: ManifestLayout,
): Promise<{ runtime: ManifestEntry[]; helpers: ManifestEntry[] }> {
  return enumerate(layout, { files: [], dirs: [] });
}
async function enumerate(
  layout: ManifestLayout,
  seen: Observed,
): Promise<{ runtime: ManifestEntry[]; helpers: ManifestEntry[] }> {
  const record = (path: string, stat: BigIntStats, bytes: Uint8Array) => {
    const entry = {
      path,
      identity: fileIdentity(stat),
      size: bytes.byteLength,
      sha256: sha256(bytes),
    };
    seen.files.push(entry);
    return entry;
  };
  const packageRoot = await realpath(layout.packageRoot);
  const helpers = new Map<string, ManifestEntry>();
  const runtimeRoots = new Map<string, string>();
  const queue = layout.helperModules.map((m) => join(packageRoot, m));
  const visited = new Set<string>();
  const thirdParty: { spec: string; from: string }[] = [];
  while (queue.length) {
    const file = await realpath(queue.pop() as string).catch(() => {
      throw new RuntimeManifestError("A helper module of the closure is missing");
    });
    if (visited.has(file)) continue;
    visited.add(file);
    const owner = await packageRootOf(file);
    if (owner.root === packageRoot) owner.name = "";
    const name = owner.name
      ? logical(`node_modules/${owner.name}`, owner.root, file)
      : logical("package", owner.root, file);
    const read = await readRegularFile(file);
    const { size, sha256: hash } = record(file, read.stat, read.bytes);
    helpers.set(name, [name, size, hash]);
    if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
    for (const spec of moduleImports(
      await readFile(file, "utf8"),
      name,
      layout.dynamicImports?.[name],
    )) {
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        queue.push(resolve(dirname(file), spec));
        continue;
      }
      if (spec.startsWith("@capybara-hq/")) {
        queue.push(createRequire(file).resolve(spec));
        continue;
      }
      // a third-party package the helpers load: covered whole, with its dependency closure
      const parts = spec.split("/");
      const pkg = spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
      if (!pkg || pkg.startsWith(".") || pkg.startsWith("/"))
        throw new RuntimeManifestError(
          `${name} imports ${spec}, which the manifest does not cover`,
        );
      thirdParty.push({ spec: pkg, from: dirname(file) });
    }
  }
  for (const [name, text] of Object.entries(layout.inline))
    helpers.set(name, textEntry(name, text));

  const runtime = new Map<string, ManifestEntry>();
  const pending: { spec: string; from: string; parent?: string; entry?: boolean }[] = [
    ...thirdParty,
    // resolved from where the worker runs (dist/exec), so a bundled dist/node_modules wins
    ...layout.runtimePackages.map((spec, i) => ({
      spec,
      from: join(packageRoot, dirname(layout.helperModules[0] ?? "package.json")),
      entry: i === 0,
    })),
  ];
  const dependencies: { parent: string; spec: string; root: string }[] = [];
  while (pending.length) {
    const { spec, from, parent, entry } = pending.pop() as (typeof pending)[number];
    let manifest: string;
    try {
      manifest = await realpath(
        createRequire(join(from, "package.json")).resolve(`${spec}/package.json`),
      );
    } catch {
      // packages whose exports hide package.json: resolve the entry and walk up
      const entry = await realpath(createRequire(join(from, "package.json")).resolve(spec)).catch(
        () => {
          throw new RuntimeManifestError(`Runtime package ${spec} is not installed`);
        },
      );
      manifest = join((await packageRootOf(entry)).root, "package.json");
    }
    const root = dirname(manifest);
    if (parent) dependencies.push({ parent, spec, root });
    if (entry) {
      const main = await realpath(createRequire(join(from, "package.json")).resolve(spec)).catch(
        () => {
          throw new RuntimeManifestError(`Runtime package ${spec} has no entry module`);
        },
      );
      const rel = relative(root, main);
      if (rel.startsWith("..") || rel === "")
        throw new RuntimeManifestError(`The entry of ${spec} is outside its package`);
      seen.entry = { id: runtimeRoots.get(root) ?? "", rel: rel.split(sep).join("/") };
    }
    if (runtimeRoots.has(root)) continue;
    const pkg = JSON.parse(await readFile(manifest, "utf8")) as {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    if (pkg.name !== spec) throw new RuntimeManifestError(`${spec} resolved to ${pkg.name}`);
    const id = `${pkg.name}@${pkg.version}`;
    // only declared dependencies are staged as links inside the copy; a peer or optional one
    // would be resolved wherever Node finds it, outside the verified closure
    for (const field of ["peerDependencies", "optionalDependencies"] as const)
      if (Object.keys(pkg[field] ?? {}).length)
        throw new RuntimeManifestError(
          `${id} declares ${field}, which the runtime closure cannot pin; it cannot be verified`,
        );
    if ([...runtimeRoots.values()].includes(id))
      throw new RuntimeManifestError(
        `Two installed copies of ${id}; the manifest cannot name both`,
      );
    runtimeRoots.set(root, id);
    if (entry && seen.entry) seen.entry.id = id;
    const meta = `meta/${id}`;
    runtime.set(meta, textEntry(meta, id));
    for (const file of await packageFiles(root, seen.dirs)) {
      const name = logical(`node_modules/${id}`, root, file);
      const read = await readRegularFile(file);
      const { size, sha256: hash } = record(file, read.stat, read.bytes);
      runtime.set(name, [name, size, hash]);
      // staged from the very bytes just hashed
      await seen.stager?.file(
        id,
        name.slice(`node_modules/${id}/`.length),
        read.bytes,
        (read.stat.mode & 0o100n) !== 0n,
      );
    }
    for (const dep of Object.keys(pkg.dependencies ?? {}))
      pending.push({ spec: dep, from: root, parent: id });
  }
  for (const d of dependencies) {
    const to = runtimeRoots.get(d.root);
    if (!to) throw new RuntimeManifestError(`${d.spec} was resolved but not enumerated`);
    await seen.stager?.dependency(d.parent, d.spec, to);
  }
  return {
    runtime: checkEntries([...runtime.values()]),
    helpers: checkEntries([...helpers.values()]),
  };
}

/** Reads the shipped manifest beside the program (a regular file, never a link). */
export async function readShippedManifest(packageRoot: string): Promise<ShippedManifest> {
  const path = join(packageRoot, "dist", MANIFEST_FILE);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new RuntimeManifestError("The installed program has no runtime manifest; reinstall it");
  });
  let raw: unknown;
  try {
    if (!(await file.stat()).isFile()) throw new RuntimeManifestError("Invalid runtime manifest");
    raw = JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
  const o = raw as Partial<ShippedManifest> | null;
  if (
    !o ||
    typeof o !== "object" ||
    Object.keys(o).sort().join() !== "helpers,runtime,version" ||
    o.version !== 1 ||
    !Array.isArray(o.runtime) ||
    !Array.isArray(o.helpers)
  )
    throw new RuntimeManifestError("Invalid runtime manifest");
  return { version: 1, runtime: checkEntries(o.runtime), helpers: checkEntries(o.helpers) };
}

function firstDifference(want: readonly ManifestEntry[], got: readonly ManifestEntry[]): string {
  const a = new Map(want.map((e) => [e[0], JSON.stringify(e)]));
  const b = new Map(got.map((e) => [e[0], JSON.stringify(e)]));
  for (const [name, v] of a)
    if (b.get(name) !== v) return b.has(name) ? `changed ${name}` : `missing ${name}`;
  for (const name of b.keys()) if (!a.has(name)) return `unexpected ${name}`;
  return "unknown difference";
}

const run = promisify(execFile);
/**
 * The top-level modules a Python source imports (`import a, b.c as d`, `from x import y`, at any
 * indentation; relative imports have none to resolve).
 */
export function pythonImports(source: string): string[] {
  const out = new Set<string>();
  for (const line of source.split("\n")) {
    const from = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s/.exec(line);
    if (from) out.add(from[1] as string);
    const plain = /^\s*import\s+([\w.,\s]+?)\s*(?:#.*)?$/.exec(line);
    if (plain)
      for (const part of (plain[1] as string).split(",")) {
        const name = part
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name && /^[A-Za-z_][\w.]*$/.test(name)) out.add(name);
      }
  }
  return [...out].sort();
}
/** The Python sources the fixed helpers run (their imports join the environment fingerprint). */
export function helperPythonSources(): string[] {
  const inline = installedLayout().inline;
  return Object.entries(inline)
    .filter(([name]) => name.endsWith(".py"))
    .map(([, source]) => source);
}
/** Isolated interpreter probe: imports the helpers' modules (argv[1]), reports what loaded. */
const PYTHON_PROBE = [
  "import os,sys,json,sysconfig,importlib",
  "[importlib.import_module(m) for m in json.loads(sys.argv[1])]",
  "files=sorted({os.path.realpath(m.__file__) for m in list(sys.modules.values()) if getattr(m,'__file__',None)})",
  "lib=os.path.join(sysconfig.get_config_var('LIBDIR') or '',sysconfig.get_config_var('LDLIBRARY') or '')",
  "files+=[os.path.realpath(lib)] if os.path.isfile(lib) else []",
  "print(json.dumps({'executable':os.path.realpath(sys.executable),'version':sys.version,'base':os.path.realpath(sys.base_prefix),'files':files}))",
].join("\n");

/** Trusted inputs of the environment fingerprint; never decoded from a request. */
export interface EnvironmentInputs {
  pythonPath: string;
  shellPath?: string;
  roots: { workspace: string; skills: string; tmp: string };
  /** A provider's verified immutable image digest; null for host execution. */
  providerImageDigest?: string | null;
  /** The Python helper sources whose imports are fingerprinted (default: the shipped helpers). */
  pythonSources?: readonly string[];
}
export async function collectEnvironment(input: EnvironmentInputs): Promise<EnvironmentFacts> {
  const nodeRealPath = await realpath(process.execPath);
  const pythonRealPath = await realpath(input.pythonPath);
  const shellRealPath = await realpath(input.shellPath ?? "/bin/bash");
  const osBuild =
    platform() === "darwin"
      ? (await run("/usr/bin/sw_vers", ["-buildVersion"])).stdout.trim()
      : `${release()} ${version()}`;
  const probe = JSON.parse(
    (
      await run(
        pythonRealPath,
        [
          "-I",
          "-c",
          PYTHON_PROBE,
          JSON.stringify([
            ...new Set((input.pythonSources ?? helperPythonSources()).flatMap(pythonImports)),
          ]),
        ],
        { env: {} },
      )
    ).stdout,
  ) as { executable: string; version: string; base: string; files: string[] };
  const libraries: ManifestEntry[] = [];
  const add = async (file: string) => {
    const name = file.startsWith(`${probe.base}/`)
      ? `python/${relative(probe.base, file)}`
      : `python-abs${file}`;
    if (libraries.some((e) => e[0] === name)) return;
    const { size, sha256: hash } = await hashRegularFile(file);
    libraries.push([name, size, hash]);
  };
  await add(probe.executable);
  for (const file of probe.files) await add(file);
  const uid = process.geteuid?.() ?? -1;
  const [node, python, shell] = await Promise.all([
    hashRegularFile(nodeRealPath),
    hashRegularFile(pythonRealPath),
    hashRegularFile(shellRealPath),
  ]);
  return {
    platform: platform(),
    arch: arch(),
    osBuild,
    effectiveUid: uid,
    nodeRealPath,
    nodeSha256: node.sha256,
    nodeVersion: process.version,
    pythonRealPath,
    pythonSha256: python.sha256,
    pythonVersion: probe.version,
    shellRealPath,
    shellSha256: shell.sha256,
    providerImageDigest: input.providerImageDigest ?? null,
    interpreterLibraryEntries: checkEntries(libraries),
    // trusted instance roots, the execution uid and the absolute host boundary; never the
    // restricted-profile domains or projects, so restricted-only edits are not a changed runtime
    environmentBoundaryDigest: sha256(
      JSON.stringify([
        1,
        "boundary",
        [input.roots.workspace, input.roots.skills, input.roots.tmp],
        uid,
        input.providerImageDigest ? "provider" : "host-same-user",
      ]),
    ),
  };
}

export interface VerifiedRuntime {
  runtimeHash: string;
  helperHash: string;
  imageFingerprint: string;
}
/**
 * Verifies the installed program against its shipped manifest and fingerprints the environment.
 * Throws {@link RuntimeManifestError} on a missing, changed, extra or unverifiable file: no
 * identity, so nothing is attested and nothing is admitted.
 */
export async function verifyInstalledRuntime(
  environment: EnvironmentInputs,
  layout: ManifestLayout = installedLayout(),
  options: {
    /**
     * The private state directory to stage the verified runtime closure in. Restricted workers
     * launch only from a staged, sealed copy (`sealedRuntimeEntry`), so the verifier a binding
     * relies on passes it; a verification without it seals nothing.
     */
    stageIn?: string;
  } = {},
): Promise<VerifiedRuntime> {
  const seen: Observed = { files: [], dirs: [] };
  if (options.stageIn) seen.stager = await ClosureStager.begin(options.stageIn);
  try {
    const shipped = await readShippedManifest(await realpath(layout.packageRoot));
    const installed = await enumerate(layout, seen);
    for (const kind of ["runtime", "helpers"] as const)
      if (canonicalManifest(kind, shipped[kind]) !== canonicalManifest(kind, installed[kind]))
        throw new RuntimeManifestError(
          `Installed ${kind} differ from the shipped manifest (${firstDifference(shipped[kind], installed[kind])}); reinstall capybara-device`,
        );
    const verified = {
      runtimeHash: manifestHash("runtime", installed.runtime),
      helperHash: manifestHash("helpers", installed.helpers),
      imageFingerprint: environmentHash(await collectEnvironment(environment)),
    };
    if (seen.stager) {
      if (!seen.entry?.id) throw new RuntimeManifestError("The layout names no runtime package");
      await seen.stager.commit({
        runtimeHash: verified.runtimeHash,
        entry: seen.entry,
        files: seen.files,
        dirs: seen.dirs,
      });
    }
    return verified;
  } catch (e) {
    await seen.stager?.abort();
    throw e;
  }
}
