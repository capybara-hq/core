import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  collectImports,
  type Finding,
  isParseError,
  listSourceFiles,
  parseFile,
} from "./source.js";

export type { Finding };

const SCOPE = "@capybara-hq/";
const SDK = "@capybara-hq/plugin-sdk";
const DEP_FIELDS = ["dependencies", "peerDependencies", "devDependencies"] as const;

const MSG_PLUGIN = (what: string) =>
  `插件只能依赖 ${SDK} 与第三方 npm 包，不能依赖 ${what}；需要的能力应通过 ctx 提供（缺了就扩 plugin-sdk 的契约）`;
const MSG_SDK = (what: string) =>
  `packages/plugin-sdk 只含类型与纯函数，不得依赖其他 @capybara-hq/* 包（出现 ${what}）`;
const MSG_OUTSIDE = (spec: string) =>
  `相对路径 ${spec} 指向插件目录之外，等于绕过包名检查直接依赖内核源码；插件只能 import 自己目录内的文件`;

function packageFindings(
  dir: string,
  rule: string,
  isAllowed: (field: string, name: string) => boolean,
  message: (name: string) => string,
): Finding[] {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  const pkg = JSON.parse(lines.join("\n")) as Record<string, Record<string, string> | undefined>;
  const out: Finding[] = [];
  for (const field of DEP_FIELDS) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (!name.startsWith(SCOPE) || isAllowed(field, name)) continue;
      const line = lines.findIndex((l) => l.includes(`"${name}"`)) + 1;
      out.push({
        file,
        line: Math.max(line, 1),
        rule,
        message: `${field} 中的 ${name}：${message(name)}`,
      });
    }
  }
  return out;
}

/**
 * 依赖边界检查。
 * - pluginDirs：每个插件目录（扫描源码 import 与 package.json 依赖），违规 rule 为 plugin-imports-kernel
 *   （相对路径绕出插件目录为 plugin-imports-outside）；
 * - sdkDirs：packages/plugin-sdk 包目录，其源码与依赖里出现任何 @capybara-hq/* 为 sdk-imports-internal。
 * devDependencies 里的 @capybara-hq/testing 放行（测试工具，不进运行时）。
 */
export function checkDeps(pluginDirs: string[], sdkDirs: string[] = []): Finding[] {
  const findings: Finding[] = [];

  for (const dir of pluginDirs) {
    findings.push(
      ...packageFindings(
        dir,
        "plugin-imports-kernel",
        (field, name) =>
          name === SDK || (field === "devDependencies" && name === "@capybara-hq/testing"),
        MSG_PLUGIN,
      ),
    );
    for (const file of listSourceFiles(dir)) {
      const parsed = parseFile(file);
      if (isParseError(parsed)) {
        findings.push(parsed);
        continue;
      }
      for (const { spec, start } of collectImports(parsed.program)) {
        const line = parsed.lineOf(start);
        if (spec.startsWith(SCOPE)) {
          if (spec !== SDK && !spec.startsWith(`${SDK}/`)) {
            findings.push({ file, line, rule: "plugin-imports-kernel", message: MSG_PLUGIN(spec) });
          }
        } else if (spec.startsWith(".") || isAbsolute(spec)) {
          const target = resolve(join(file, ".."), spec);
          if (relative(resolve(dir), target).startsWith("..")) {
            findings.push({
              file,
              line,
              rule: "plugin-imports-outside",
              message: MSG_OUTSIDE(spec),
            });
          }
        }
      }
    }
  }

  for (const dir of sdkDirs) {
    findings.push(
      ...packageFindings(
        dir,
        "sdk-imports-internal",
        () => false,
        (name) => MSG_SDK(name),
      ),
    );
    for (const file of listSourceFiles(join(dir, "src"))) {
      const parsed = parseFile(file);
      if (isParseError(parsed)) {
        findings.push(parsed);
        continue;
      }
      for (const { spec, start } of collectImports(parsed.program)) {
        if (spec.startsWith(SCOPE)) {
          findings.push({
            file,
            line: parsed.lineOf(start),
            rule: "sdk-imports-internal",
            message: MSG_SDK(spec),
          });
        }
      }
    }
  }
  return findings;
}
