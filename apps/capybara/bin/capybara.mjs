#!/usr/bin/env node
// 从源码运行 CLI 的入口。tsx 只认当前工作目录下（且 include 覆盖到的）tsconfig，从任意目录运行时
// 内核源码会丢掉 experimentalDecorators（Nest 装饰器无法编译），所以这里显式指定仓库的 tsconfig.base.json；
// 同时补上 `@capybara-hq/source` 导出条件，让 workspace 包解析到 src 而不是 dist。
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { register as registerTsx } from "tsx/esm/api";

registerTsx({ tsconfig: fileURLToPath(new URL("../../../tsconfig.base.json", import.meta.url)) });
register(
  "data:text/javascript,export function resolve(s, c, next) { return next(s, { ...c, conditions: [...c.conditions, '@capybara-hq/source'] }); }",
);
await import("../src/cli.ts");
