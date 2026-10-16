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

/** 把 `CAPYBARA_A__B_C=x` 形式的环境变量转成嵌套对象 `{ a: { bC: x } }`。 */
export function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (raw === undefined || !key.startsWith(PREFIX)) continue;
    if (IGNORED.some((p) => key.startsWith(p))) continue;
    const path = key.slice(PREFIX.length).split("__").map(snakeToCamel);
    if (path.some((s) => s === "")) continue;
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
