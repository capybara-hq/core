import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { ConfigSource } from "./load.js";

/** 从 YAML 文件读取配置；未指定路径时返回空对象（纯环境变量配置）。 */
export function fileSource(path: string | undefined): ConfigSource {
  return {
    async load(): Promise<unknown> {
      if (!path) return {};
      const text = await readFile(path, "utf8");
      return parse(text) ?? {};
    },
  };
}
