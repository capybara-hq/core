import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOST_PROVIDED_PACKAGES, isSafePackagePath } from "@capybara-hq/plugin-sdk";
import { extractPluginPackage, type PluginPackageLimits } from "./package.js";

/**
 * 把内容寻址的插件包同步到本副本的本地目录（C13）：`<dir>/<name>/<sha256 前 16 位>/`。
 *
 * - 目录里有校验文件 {@link MARKER} 且其中每个文件的 sha256 都对得上 → 直接复用（同一 sha 重启不再下载）；
 * - 否则取包（`blobs.get` 按记录的存放位置读取并校验 sha256），先解到同级的临时目录、写好宿主包链接与校验文件，
 *   再改名换入；目标位置的残缺目录先删掉。并发的同机进程各自解到自己的临时目录，改名失败时以已就位且完整的为准。
 * - `node_modules/` 下为 {@link HOST_PROVIDED_PACKAGES} 建指向宿主副本的符号链接：插件 import 的 SDK 与 zod
 *   就是内核用的那一份（同一模块实例）。插件目录不在宿主 `node_modules` 的上游，别的包一概解析不到。
 */

/** 从包存储取到的字节与安装记录的 sha256 不符。 */
export class PackageShaMismatchError extends Error {
  constructor(name: string, sha: string) {
    super(`package ${name}: downloaded bytes do not match sha256 ${sha}`);
    this.name = "PackageShaMismatchError";
  }
}

/** 解包完成后写入包根的校验文件（`wx` 写入：包里自带同名文件时同步失败）。 */
export const MARKER = ".capybara-package.json";

/** 插件名规则同清单（`definePlugin` 的 name 校验），用作目录名。 */
const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

interface Marker {
  sha256: string;
  entry: string;
  /** 包内文件（相对包根） → sha256。 */
  files: Record<string, string>;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** 从内核所在位置向上找 `node_modules/<pkg>`（与 Node 的解析路径一致，不看 exports / 条件），返回真实路径。 */
function hostPackageDir(pkg: string): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(d, "node_modules", ...pkg.split("/"));
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const up = dirname(d);
    if (up === d) throw new Error(`cannot find the host copy of ${pkg}`);
    d = up;
  }
}

let hostDirs: Map<string, string> | undefined;
/** 宿主提供的包 → 宿主副本目录（首次调用时解析；进程内只读）。 */
function hostPackageDirs(): Map<string, string> {
  hostDirs ??= new Map(HOST_PROVIDED_PACKAGES.map((p) => [p, hostPackageDir(p)]));
  return hostDirs;
}

/** 已就位的目录是否完整：校验文件的 sha256 对得上、每个文件内容对得上、宿主包链接都在。 */
async function intact(root: string, sha: string): Promise<Marker | undefined> {
  let marker: Marker;
  try {
    marker = JSON.parse(await readFile(join(root, MARKER), "utf8")) as Marker;
  } catch {
    return undefined;
  }
  if (marker.sha256 !== sha || typeof marker.files !== "object" || !marker.files) return undefined;
  if (typeof marker.entry !== "string" || !Object.hasOwn(marker.files, marker.entry))
    return undefined;
  for (const [path, digest] of Object.entries(marker.files)) {
    if (!isSafePackagePath(path)) return undefined;
    try {
      if (sha256(await readFile(join(root, path))) !== digest) return undefined;
    } catch {
      return undefined;
    }
  }
  for (const pkg of HOST_PROVIDED_PACKAGES) {
    if (!existsSync(join(root, "node_modules", ...pkg.split("/"), "package.json")))
      return undefined;
  }
  // 文件集合也要一致：多出来的文件（不在校验文件里）同样视为不完整，重新解包
  let present: string[];
  try {
    present = (await listFiles(root)).filter((f) => f !== MARKER);
  } catch {
    return undefined;
  }
  const expected = Object.keys(marker.files);
  if (present.length !== expected.length || present.some((f) => !Object.hasOwn(marker.files, f))) {
    return undefined;
  }
  return marker;
}

/** 列出目录下的全部普通文件（相对路径，`/` 分隔；不跟随符号链接，宿主包链接不算）。 */
async function listFiles(root: string, sub = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, sub), { withFileTypes: true })) {
    const rel = sub === "" ? e.name : `${sub}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listFiles(root, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/**
 * 同步一个包到本地并返回 entry 的 file URL（见文件头）。`limits` 与安装时校验用同一组（`packages.maxBytes`），
 * 缺省按包自身大小。名字、sha256 不合法或取到的字节与 sha256 不符时抛错，不落盘。
 */
export async function syncPackage(
  dir: string,
  name: string,
  sha: string,
  blobs: { get(sha256: string): Promise<Uint8Array> },
  limits?: PluginPackageLimits,
): Promise<string> {
  if (!PLUGIN_NAME_RE.test(name)) throw new Error(`invalid plugin name "${name}"`);
  if (!SHA256_RE.test(sha)) throw new Error(`invalid package sha256 "${sha}"`);
  const base = join(resolvePath(dir), name);
  const root = join(base, sha.slice(0, 16));
  const urlOf = (m: Marker) => pathToFileURL(join(root, ...m.entry.split("/"))).href;

  const existing = await intact(root, sha);
  if (existing) return urlOf(existing);

  const bytes = await blobs.get(sha);
  if (sha256(bytes) !== sha) throw new PackageShaMismatchError(name, sha);
  await mkdir(base, { recursive: true, mode: 0o755 });
  const tmp = join(base, `.tmp-${sha.slice(0, 16)}-${randomBytes(4).toString("hex")}`);
  try {
    await extractPluginPackage(bytes, tmp, limits ?? { maxBytes: bytes.byteLength });
    const pkg = JSON.parse(await readFile(join(tmp, "package.json"), "utf8")) as {
      capybara?: { entry?: unknown };
    };
    const entry = pkg.capybara?.entry;
    if (typeof entry !== "string" || !isSafePackagePath(entry)) {
      throw new Error(`package ${name}: capybara.entry is missing`);
    }
    const files: Record<string, string> = {};
    for (const f of await listFiles(tmp)) files[f] = sha256(await readFile(join(tmp, f)));
    if (!Object.hasOwn(files, entry)) throw new Error(`package ${name}: entry ${entry} not found`);
    for (const [pkgName, target] of hostPackageDirs()) {
      const link = join(tmp, "node_modules", ...pkgName.split("/"));
      await mkdir(dirname(link), { recursive: true, mode: 0o755 });
      await symlink(target, link, "dir");
    }
    const marker: Marker = { sha256: sha, entry, files };
    await writeFile(join(tmp, MARKER), JSON.stringify(marker), { flag: "wx", mode: 0o644 });
    // 换入：解包期间同机另一个进程可能已换入完整的目录——以它为准，不删；否则先移走残缺目录
    const done = await intact(root, sha);
    if (done) return urlOf(done);
    if (await exists(root)) await rm(root, { recursive: true, force: true });
    try {
      await rename(tmp, root);
    } catch (e) {
      // 同机另一个进程刚换入：以它为准（必须完整），否则抛原错误
      const other = await intact(root, sha);
      if (!other) throw e;
      return urlOf(other);
    }
    return urlOf(marker);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

const exists = async (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** `syncPackage` 返回的 entry URL 对应的包根目录（去掉 entry 的各段）。 */
export function packageRootOf(entryUrl: string, entry: string): string {
  const file = fileURLToPath(entryUrl);
  const root = resolvePath(file, ...entry.split("/").map(() => ".."));
  const rel = relative(root, file);
  if (rel.startsWith("..") || rel.split(sep).join("/") !== entry) {
    throw new Error(`entry ${entry} is not inside ${root}`);
  }
  return root;
}
