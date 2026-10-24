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
  ExtensionPackageError,
  type PackageFile,
  parsePackageJsonFile,
  unpackPackageTgz,
} from "../extensions/package.js";
import {
  checkSkillFiles,
  readZipFiles,
  SkillArchiveError,
  type SkillPackageFile,
  stripWrapper,
} from "../skills/package.js";

/**
 * Reading and validating enterprise catalog packages (C21). A package is always treated as hostile
 * input, and the caller writes nothing until every check passes (F-AD):
 *
 * - tgz (npm pack): the same unpack rules and limits as extension packages (extensions/package.ts
 *   `unpackPackageTgz`: decompression cap, regular files only, paths safe and under `package/`,
 *   case-insensitive dedup, no node_modules / native modules);
 * - zip (connector templates and skills only, package.json at the root; a single outer directory is
 *   stripped by the skill package rules): the same read rules and limits as skill packages
 *   (skills/package.ts `readZipFiles`: trusts only the central directory, counts actual bytes, refuses
 *   links / encryption / bombs);
 * - `package.json`: strict UTF-8 JSON ≤ 1 MiB, its `capybara` section validated by plugin-sdk
 *   `parsePackageSection`;
 * - skills: every file except package.json is the skill content, validated by the skill package rules
 *   (SKILL.md required, per-file / total / file-count limits, paths); the skill name is the SKILL.md
 *   name;
 * - connector templates: the template's static rules (no credentials, auth presets, editableEndpoint
 *   format) live in the SDK; the icon must be in the package, ≤ 64KB, and really svg (UTF-8 text
 *   containing `<svg`) or png (file header). Checking the endpoint against the connector's
 *   `endpointSchema` needs the connector loaded and is done by CatalogService.
 *
 * Invalid -> `catalog.invalid_package` (400), details list each problem (in English, without echoing
 * values from the package).
 */

/** 读出并校验后的目录包（非插件）。`name` 为目录条目名。 */
export interface CatalogArchive {
  packageJson: Record<string, unknown>;
  section: ConnectorTemplateSection | SkillPackageSection | AppPackageSection;
  /** 条目名：技能取 SKILL.md 的 name，连接器模板取去掉 scope 的 npm 包名，应用取去掉 scope 的 npm 包名。 */
  name: string;
  /** 要存的文件：技能为全部技能文件，连接器模板为图标（没有则为空），应用为空（T25）。 */
  files: SkillPackageFile[];
}

/** 解开但还没按种类校验内容的目录包。 */
export interface UnpackedCatalogArchive {
  format: "tgz" | "zip";
  packageJson: Record<string, unknown>;
  section: PackageSection;
  /** 包内文件（路径相对包根）。 */
  files: { path: string; data: Uint8Array }[];
}

export const invalidPackage = (problems: string[]): ApiError =>
  new ApiError(
    "catalog.invalid_package",
    `Invalid catalog package: ${problems[0] ?? "unknown problem"}`,
    problems,
  );

const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
const isZip = (b: Uint8Array) =>
  b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05);

/**
 * Detects tgz / zip by the file header and unpacks it, reads package.json and parses the `capybara`
 * section (any kind). Does not check that the content is complete; full extension package validation
 * is done by `readExtensionPackage` (the caller hands the raw bytes to the extension package flow).
 * Invalid -> `catalog.invalid_package`.
 */
export async function unpackCatalogArchive(
  bytes: Uint8Array,
  maxBytes: number,
): Promise<UnpackedCatalogArchive> {
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
    if (e instanceof ExtensionPackageError) throw invalidPackage(e.issues);
    if (e instanceof SkillArchiveError) throw invalidPackage(e.problems);
    throw e;
  }
  const pj = files.find((f) => f.path === "package.json");
  let packageJson: unknown;
  try {
    packageJson = parsePackageJsonFile(pj && { data: Buffer.from(pj.data) });
  } catch (e) {
    if (e instanceof ExtensionPackageError) throw invalidPackage(e.issues);
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

export const toFile = (f: { path: string; data: Uint8Array }): SkillPackageFile => ({
  path: f.path,
  size: f.data.byteLength,
  sha256: createHash("sha256").update(f.data).digest("hex"),
  data: f.data,
});

/** 图标内容确实是 svg / png（只看文件头与 UTF-8 文本，不渲染）；合法返回 undefined。 */
export function iconProblem(path: string, data: Uint8Array): string | undefined {
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
 * Checks the unpacked content of a non-plugin catalog package by kind (see the file header) and
 * returns the item name and the files to store. Plugin package -> `catalog.invalid_package`
 * (plugin packages go through the extension package flow).
 */
export function checkCatalogArchive(u: UnpackedCatalogArchive): CatalogArchive {
  const { section, packageJson } = u;
  if (section.kind === "plugin") {
    throw invalidPackage([
      "plugin packages are imported through the plugin package flow (readExtensionPackage)",
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
 * Reads and checks a non-plugin catalog package (connector templates, skills; apps only parse the
 * section, the content is left to T25). `maxBytes` is `packages.maxBytes`. Plugin packages are not
 * read here (-> `catalog.invalid_package`). Invalid -> `catalog.invalid_package`.
 */
export async function readCatalogArchive(
  bytes: Uint8Array,
  maxBytes: number,
): Promise<CatalogArchive> {
  return checkCatalogArchive(await unpackCatalogArchive(bytes, maxBytes));
}
