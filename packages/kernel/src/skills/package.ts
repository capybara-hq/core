import { createHash } from "node:crypto";
import {
  parseSkillMd,
  SKILL_ENTRY_FILE,
  SKILL_LIMITS,
  validateSkillPackage,
} from "@capybara-hq/plugin-sdk";
import yauzl from "yauzl";
import { ApiError } from "../errors.js";

/**
 * 技能包（zip）解包与校验。zip 一律当作恶意输入：
 *
 * - 解析用 yauzl（3.4.0，固定版本）：只信中央目录、按条目随机读取（不按本地头顺序猜），自带
 *   `validateEntrySizes`（实际解压出的字节数必须等于声明值）与文件名检查（绝对路径、盘符、`..`、
 *   `strictFileNames` 下的反斜杠）。不选 fflate：它的同步解压会先把整个条目解到内存，流式解压又按本地头顺序走，
 *   遇到声明与实际不一致的恶意包更难兜住。
 * - 此外自己再按**实际**解压出的字节数计数：单文件超过 {@link SKILL_LIMITS.fileBytes}、累计超过
 *   {@link SKILL_LIMITS.totalBytes} 立即中止；条目数上限 {@link SKILL_PACKAGE_MAX_ENTRIES}；声明的压缩比
 *   超过 {@link MAX_COMPRESSION_RATIO}（且解压后超过 1 MiB）视为 zip 炸弹，提前拒绝、不做解压
 *   （deflate 的理论上限约 1032:1，正常文本即使高度重复也远低于 1000:1；真正兜底的是按实际字节的上限）；拒绝符号链接与其他非普通文件
 *   （外部属性里的 Unix mode）、加密条目、stored / deflate 之外的压缩方法。
 * - 路径与清单规则（必须有 SKILL.md、去重、大小写冲突、控制字符、沙箱路径）见 plugin-sdk `validateSkillPackage`。
 *
 * 整个 zip（≤ {@link SKILL_PACKAGE_MAX_BYTES}）与解出的文件（≤ 50MB）都在内存里处理。
 */

/** 技能包 zip 本身的大小上限（字节）。 */
export const SKILL_PACKAGE_MAX_BYTES = 50 * 1024 * 1024;
/** zip 中央目录的条目数上限（含目录项与被忽略的条目）。 */
export const SKILL_PACKAGE_MAX_ENTRIES = 1000;
/** 单个条目声明的「解压后 / 压缩后」比值上限（只挡近乎单一字节重复的炸弹，正常文本不会触发）。 */
export const MAX_COMPRESSION_RATIO = 1000;
/** 解压后不超过这么大的条目不看压缩比（小文本本来就能压得很小）。 */
const RATIO_MIN_BYTES = 1024 * 1024;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** 包里的一个文件（路径相对于技能根目录）。 */
export interface SkillPackageFile {
  path: string;
  size: number;
  /** 十六进制 sha256。 */
  sha256: string;
  data: Uint8Array;
}

/** 解包并校验后的技能包。 */
export interface SkillPackage {
  name: string;
  description: string;
  files: SkillPackageFile[];
}

/** 打包工具顺手带上的垃圾文件：macOS 的资源分支目录与 Finder 的 `.DS_Store`，直接跳过。 */
const ignored = (path: string) =>
  path.startsWith("__MACOSX/") || path === ".DS_Store" || path.endsWith("/.DS_Store");

const invalid = (problems: string[]) =>
  new ApiError(
    "skill.invalid_package",
    `Invalid skill package: ${problems[0] ?? "unknown problem"}`,
    problems.map((message) => ({ path: "package", message })),
  );

/** 读一个条目的全部字节：按实际字节数计数，超过 `max` 立即中止。 */
async function readEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  max: number,
  onTooBig: () => ApiError,
): Promise<{ data: Uint8Array; sha256: string }> {
  const stream = await zip.openReadStreamPromise(entry);
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let n = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      n += chunk.length;
      if (n > max) throw onTooBig();
      hash.update(chunk);
      chunks.push(chunk);
    }
  } finally {
    stream.destroy();
  }
  return { data: new Uint8Array(Buffer.concat(chunks)), sha256: hash.digest("hex") };
}

/**
 * 外层目录规则：根目录有 SKILL.md → 原样使用；否则当且仅当全部文件都在同一个顶层目录 `D/` 下、且 `D/SKILL.md`
 * 存在时，去掉 `D/`（如 GitHub 下载的 `repo-main/`；目录名不必等于技能名，技能名只取 SKILL.md 的 name，
 * 沙箱路径用 `/skills/<name>/`）。其他情况（多个顶层条目、SKILL.md 只在更深的目录里）不猜，按缺少 SKILL.md 拒绝。
 */
export function stripWrapper<T extends { path: string }>(files: T[]): T[] {
  if (files.some((f) => f.path === SKILL_ENTRY_FILE)) return files;
  if (!files.every((f) => f.path.includes("/"))) return files;
  const tops = new Set(files.map((f) => f.path.slice(0, f.path.indexOf("/"))));
  const top = tops.size === 1 ? [...tops][0] : undefined;
  if (top === undefined || !files.some((f) => f.path === `${top}/${SKILL_ENTRY_FILE}`)) {
    return files;
  }
  return files.map((f) => ({ ...f, path: f.path.slice(top.length + 1) }));
}

/**
 * 解包并校验技能包：返回 SKILL.md 里的 name / description 与全部文件（含 sha256）。
 * 外层目录按 {@link stripWrapper} 的规则去掉。
 * 任何问题 → `skill.invalid_package`（400），details 逐条列出。
 */
export async function readSkillPackage(bytes: Uint8Array): Promise<SkillPackage> {
  if (bytes.byteLength > SKILL_PACKAGE_MAX_BYTES) {
    throw invalid([`the zip file is larger than ${SKILL_PACKAGE_MAX_BYTES} bytes`]);
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromBufferPromise(buf, {
      lazyEntries: true,
      autoClose: true,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true,
    });
  } catch {
    throw invalid(["the file is not a valid zip archive"]);
  }
  if (zip.entryCount > SKILL_PACKAGE_MAX_ENTRIES) {
    zip.close();
    throw invalid([`the zip archive has more than ${SKILL_PACKAGE_MAX_ENTRIES} entries`]);
  }

  const raw: SkillPackageFile[] = [];
  let total = 0;
  let current = "";
  try {
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      current = name;
      if (ignored(name)) continue;
      const type = (entry.externalFileAttributes >>> 16) & 0xffff & S_IFMT;
      if (type === S_IFLNK) throw invalid([`${name}: symbolic links are not allowed`]);
      if (name.endsWith("/")) {
        if (type !== 0 && type !== S_IFDIR) throw invalid([`${name}: not a regular file`]);
        continue;
      }
      if (type !== 0 && type !== S_IFREG) {
        throw invalid([`${name}: only regular files are allowed (not a regular file)`]);
      }
      if (entry.isEncrypted()) throw invalid([`${name}: encrypted entries are not supported`]);
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        throw invalid([`${name}: unsupported compression method ${entry.compressionMethod}`]);
      }
      const tooBig = () =>
        invalid([`${name}: file is larger than ${SKILL_LIMITS.fileBytes} bytes`]);
      const tooMuch = () =>
        invalid([`package is larger than ${SKILL_LIMITS.totalBytes} bytes in total`]);
      if (entry.uncompressedSize > SKILL_LIMITS.fileBytes) throw tooBig();
      if (total + entry.uncompressedSize > SKILL_LIMITS.totalBytes) throw tooMuch();
      if (
        entry.uncompressedSize > RATIO_MIN_BYTES &&
        entry.uncompressedSize > Math.max(1, entry.compressedSize) * MAX_COMPRESSION_RATIO
      ) {
        throw invalid([`${name}: suspicious compression ratio (possible zip bomb)`]);
      }
      const remaining = SKILL_LIMITS.totalBytes - total;
      const max = Math.min(SKILL_LIMITS.fileBytes, remaining);
      const { data, sha256 } = await readEntry(zip, entry, max, () =>
        max < SKILL_LIMITS.fileBytes ? tooMuch() : tooBig(),
      );
      total += data.byteLength;
      raw.push({ path: name, size: data.byteLength, sha256, data });
    }
  } catch (e) {
    zip.close();
    if (e instanceof ApiError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw invalid([current ? `${current}: ${msg}` : `the zip archive is malformed: ${msg}`]);
  }

  const files = stripWrapper(raw);

  const problems = validateSkillPackage(files);
  if (problems.length > 0) throw invalid(problems);
  const entryFile = files.find((f) => f.path === SKILL_ENTRY_FILE) as SkillPackageFile;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(entryFile.data);
  } catch {
    throw invalid([`${SKILL_ENTRY_FILE} is not valid UTF-8 text`]);
  }
  const parsed = parseSkillMd(text);
  if ("errors" in parsed) throw invalid(parsed.errors.map((m) => `${SKILL_ENTRY_FILE}: ${m}`));
  return { name: parsed.name, description: parsed.description, files };
}
