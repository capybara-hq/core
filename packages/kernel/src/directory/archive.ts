import { createHash } from "node:crypto";
import {
  type AppPackageSection,
  CONNECTOR_TEMPLATE_LIMITS,
  type ConnectorTemplateSection,
  type PackageSection,
  parsePackageSection,
  SDK_VERSION,
  type SkillPackageSection,
  unscopedPackageName,
} from "@capybara-hq/plugin-sdk";
import { ApiError } from "../errors.js";
import {
  type PackageFile,
  PluginPackageError,
  parsePackageJsonFile,
  unpackPackageTgz,
} from "../plugins/package.js";
import {
  checkSkillFiles,
  readZipFiles,
  SkillArchiveError,
  type SkillPackageFile,
  stripWrapper,
} from "../skills/package.js";

/**
 * 企业目录包（C21）的读取与校验。包一律当作恶意输入，全部检查通过之前调用方什么都不写（F-AD）：
 *
 * - tgz（npm pack）：与插件包相同的解包规则与上限（plugins/package.ts `unpackPackageTgz`：解压封顶、只许普通文件、
 *   路径在 `package/` 下且安全、大小写去重、不许 node_modules / 原生模块）；
 * - zip（只接受连接器模板与技能，根目录放 package.json；单个外层目录按技能包的规则去掉）：与技能包相同的
 *   读取规则与上限（skills/package.ts `readZipFiles`：只信中央目录、按实际字节计数、拒绝链接 / 加密 / 炸弹）；
 * - `package.json`：≤ 1 MiB 的严格 UTF-8 JSON，`capybara` 段按 plugin-sdk `parsePackageSection` 校验；
 * - 技能：除 package.json 外的全部文件即技能内容，按技能包规则校验（必须有 SKILL.md、单文件 / 总量 / 文件数上限、
 *   路径），技能名取 SKILL.md 的 name；
 * - 连接器模板：模板的静态规则（无凭据、认证预设、editableEndpoint 格式）在 SDK；图标必须在包里、≤ 64KB，
 *   内容确实是 svg（UTF-8 文本、含 `<svg`）或 png（文件头）。端点按连接器 `endpointSchema` 的校验需要已加载的
 *   连接器，由 DirectoryService 做。
 *
 * 不合法 → `directory.invalid_package`（400），details 逐条列出（英文，不回显包里的值）。
 */

/** 读出并校验后的目录包（非插件）。`name` 为目录条目名。 */
export interface DirectoryArchive {
  packageJson: Record<string, unknown>;
  section: ConnectorTemplateSection | SkillPackageSection | AppPackageSection;
  /** 条目名：技能取 SKILL.md 的 name，连接器模板取去掉 scope 的 npm 包名，应用取去掉 scope 的 npm 包名。 */
  name: string;
  /** 要存的文件：技能为全部技能文件，连接器模板为图标（没有则为空），应用为空（T25）。 */
  files: SkillPackageFile[];
}

/** 解开但还没按种类校验内容的目录包。 */
export interface UnpackedDirectoryArchive {
  format: "tgz" | "zip";
  packageJson: Record<string, unknown>;
  section: PackageSection;
  /** 包内文件（路径相对包根）。 */
  files: { path: string; data: Uint8Array }[];
}

export const invalidPackage = (problems: string[]): ApiError =>
  new ApiError(
    "directory.invalid_package",
    `Invalid directory package: ${problems[0] ?? "unknown problem"}`,
    problems,
  );

const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
const isZip = (b: Uint8Array) =>
  b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05);

/**
 * 按文件头识别 tgz / zip 并解开，读 package.json、解析 `capybara` 段（任何种类）。不看内容是否完整；
 * 插件包的完整校验由 `readPluginPackage` 做（调用方把原始字节交给插件包流程）。
 * 不合法 → `directory.invalid_package`。
 */
export async function unpackDirectoryArchive(
  bytes: Uint8Array,
  maxBytes: number,
): Promise<UnpackedDirectoryArchive> {
  if (bytes.byteLength > maxBytes) {
    throw invalidPackage([`the package is larger than ${maxBytes} bytes`]);
  }
  let format: "tgz" | "zip";
  let files: { path: string; data: Uint8Array }[];
  try {
    if (isGzip(bytes)) {
      format = "tgz";
      files = (await unpackPackageTgz(bytes, { maxBytes })).map((f: PackageFile) => ({
        path: f.path,
        data: f.data,
      }));
    } else if (isZip(bytes)) {
      format = "zip";
      files = stripWrapper(await readZipFiles(bytes, maxBytes), "package.json");
    } else {
      throw invalidPackage([
        "the file is neither an npm-pack .tgz nor a .zip archive (connector templates and skills may be zip)",
      ]);
    }
  } catch (e) {
    if (e instanceof PluginPackageError) throw invalidPackage(e.issues);
    if (e instanceof SkillArchiveError) throw invalidPackage(e.problems);
    throw e;
  }
  const pj = files.find((f) => f.path === "package.json");
  let packageJson: unknown;
  try {
    packageJson = parsePackageJsonFile(pj && { data: Buffer.from(pj.data) });
  } catch (e) {
    if (e instanceof PluginPackageError) throw invalidPackage(e.issues);
    throw e;
  }
  const section = parsePackageSection(packageJson, SDK_VERSION);
  if ("errors" in section) throw invalidPackage(section.errors);
  if (format === "zip" && (section.kind === "plugin" || section.kind === "app")) {
    throw invalidPackage([
      `${section.kind} packages must be npm-pack .tgz files (only connector templates and skills may be zip)`,
    ]);
  }
  return { format, packageJson: packageJson as Record<string, unknown>, section, files };
}

const toFile = (f: { path: string; data: Uint8Array }): SkillPackageFile => ({
  path: f.path,
  size: f.data.byteLength,
  sha256: createHash("sha256").update(f.data).digest("hex"),
  data: f.data,
});

/** 图标内容确实是 svg / png（只看文件头与 UTF-8 文本，不渲染）。 */
function iconProblem(path: string, data: Uint8Array): string | undefined {
  if (data.byteLength > CONNECTOR_TEMPLATE_LIMITS.iconBytes) {
    return `template.icon ${path} is larger than ${CONNECTOR_TEMPLATE_LIMITS.iconBytes} bytes`;
  }
  if (/\.png$/i.test(path)) {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return sig.every((b, i) => data[i] === b)
      ? undefined
      : `template.icon ${path} is not a PNG image`;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return `template.icon ${path} is not a UTF-8 SVG document`;
  }
  return /<svg[\s>/]/i.test(text) ? undefined : `template.icon ${path} is not an SVG document`;
}

/**
 * 按种类校验解开的非插件目录包内容（见文件头），返回条目名与要存的文件。
 * 插件包 → `directory.invalid_package`（插件包走插件包流程）。
 */
export function checkDirectoryArchive(u: UnpackedDirectoryArchive): DirectoryArchive {
  const { section, packageJson } = u;
  if (section.kind === "plugin") {
    throw invalidPackage([
      "plugin packages are imported through the plugin package flow (readPluginPackage)",
    ]);
  }
  const pkgName = unscopedPackageName(String(packageJson.name));
  if (section.kind === "app") {
    return { packageJson, section, name: pkgName, files: [] };
  }
  if (section.kind === "skill") {
    const files = u.files.filter((f) => f.path !== "package.json").map(toFile);
    try {
      const { name } = checkSkillFiles(files);
      return { packageJson, section, name, files };
    } catch (e) {
      if (e instanceof SkillArchiveError) throw invalidPackage(e.problems);
      throw e;
    }
  }
  const icon = section.template.icon;
  if (icon === undefined) return { packageJson, section, name: pkgName, files: [] };
  const f = u.files.find((x) => x.path === icon);
  if (!f) throw invalidPackage([`template.icon ${icon} not found in the package`]);
  const problem = iconProblem(icon, f.data);
  if (problem) throw invalidPackage([problem]);
  return { packageJson, section, name: pkgName, files: [toFile(f)] };
}

/**
 * 读取并校验非插件的目录包（连接器模板、技能；应用只解析段，内容留给 T25）。`maxBytes` 即 `packages.maxBytes`。
 * 插件包不由这里读（→ `directory.invalid_package`）。不合法 → `directory.invalid_package`。
 */
export async function readDirectoryArchive(
  bytes: Uint8Array,
  maxBytes: number,
): Promise<DirectoryArchive> {
  return checkDirectoryArchive(await unpackDirectoryArchive(bytes, maxBytes));
}
