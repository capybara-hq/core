import { ConfigError } from "./types.js";

const PREFIX = "CAPYBARA_";
const IGNORED = ["CAPYBARA_CONFIG_", "CAPYBARA_NACOS_"];

function snakeToCamel(segment: string): string {
  return segment.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function parseValue(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof parsed === "number") return String(parsed) === raw ? parsed : raw;
  if (typeof parsed === "string") return raw;
  return parsed;
}

/** 插件名段：`EXAMPLE_COUNTER` -> `example-counter`（插件名不含 `_`，映射无歧义）。 */
function snakeToKebab(segment: string): string {
  return segment.toLowerCase().replaceAll("_", "-");
}

function toPath(key: string): string[] {
  const segs = key.slice(PREFIX.length).split("__");
  const path = segs.map(snakeToCamel);
  if (path[0] === "pluginConfig" && segs.length > 1) path[1] = snakeToKebab(segs[1] as string);
  return path;
}

/**
 * 把 `CAPYBARA_A__B_C=x` 形式的环境变量转成嵌套对象 `{ a: { bC: x } }`。
 * `pluginConfig` 下第二段是插件名，按 snake -> kebab 转换。
 * 同时存在 `CAPYBARA_X`（标量）与 `CAPYBARA_X__Y`（嵌套）时抛 ConfigError。
 */
export function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const entries: { key: string; path: string[]; raw: string }[] = [];
  for (const [key, raw] of Object.entries(env)) {
    if (raw === undefined || !key.startsWith(PREFIX)) continue;
    if (IGNORED.some((p) => key.startsWith(p))) continue;
    const path = toPath(key);
    if (path.some((s) => s === "")) continue;
    entries.push({ key, path, raw });
  }
  for (const a of entries) {
    for (const b of entries) {
      if (a.path.length < b.path.length && a.path.every((s, i) => s === b.path[i])) {
        throw new ConfigError(
          `conflicting environment variables: ${a.key} sets a scalar but ${b.key} sets a nested value under it`,
        );
      }
    }
  }
  const out: Record<string, unknown> = {};
  for (const { path, raw } of entries) {
    let node = out;
    for (const seg of path.slice(0, -1)) {
      const next = node[seg];
      if (typeof next === "object" && next !== null && !Array.isArray(next)) {
        node = next as Record<string, unknown>;
      } else {
        const created: Record<string, unknown> = {};
        node[seg] = created;
        node = created;
      }
    }
    node[path[path.length - 1] as string] = parseValue(raw);
  }
  return out;
}
