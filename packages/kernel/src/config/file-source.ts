import { readFile } from "node:fs/promises";
import { parse, YAMLParseError } from "yaml";
import { ConfigError, type ConfigSource } from "./types.js";

/** 从 YAML 文件读取配置；未指定路径时返回空对象（纯环境变量配置）。错误信息不含文件内容。 */
export function fileSource(path: string | undefined): ConfigSource {
  return {
    async load(): Promise<unknown> {
      if (!path) return {};
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "unknown error";
        throw new ConfigError(`cannot read config file '${path}': ${code}`);
      }
      try {
        return parse(text) ?? {};
      } catch (e) {
        if (e instanceof YAMLParseError) {
          const pos = e.linePos?.[0];
          const at = pos ? ` at line ${pos.line}, column ${pos.col}` : "";
          throw new ConfigError(`invalid YAML in config file '${path}'${at}`);
        }
        throw new ConfigError(`invalid YAML in config file '${path}'`);
      }
    },
  };
}
