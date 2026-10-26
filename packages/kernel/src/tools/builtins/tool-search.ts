import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import { BUILTIN_TOOL_NAMES, type BuiltinTool, type ResolvedTool } from "../registry.js";

/** 内置工具名。 */
export const TOOL_SEARCH = "tool_search";

/** 默认返回的匹配数。 */
const DEFAULT_LIMIT = 5;
/** 单次最多返回的匹配数。 */
const MAX_LIMIT = 10;
/** 目录行里描述的最大字符数。 */
const MAX_CATALOG_DESCRIPTION = 200;
/** key 中的词比描述中的词权重更高（key 是工具最直接的名字）。 */
const KEY_WEIGHT = 2;

export const TOOL_SEARCH_SPEC: ToolSpec = {
  name: TOOL_SEARCH,
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["query"],
  description:
    "Search the tool catalog by keywords and load the matching tools. Tools listed in the " +
    "catalog are not loaded: call this tool first with keywords from the task (for example the " +
    "app, object or action), then call the loaded tools from your next step on. Returns the full " +
    "definition (name, description, input schema) of the best matches. Do not use it for tools " +
    "you already have.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Keywords describing the tool you need, e.g. 'create calendar event'.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Maximum number of tools to load. Default ${DEFAULT_LIMIT}.`,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

/** 目录（system 第二个块）的开头说明（模型可见，英文）。 */
export const CATALOG_HEADER =
  "More tools are available but not loaded. To use one, first call tool_search with keywords; " +
  "it returns the full definitions and loads the matching tools for your next step. " +
  "Calling a tool that is not loaded returns an error. Tool catalog:";

/** 调用目录里尚未加载的工具（模型可见，英文；spec 5.5：不自动加载）。 */
export const notLoadedText = (key: string): string =>
  `Tool "${key}" is not loaded. Call tool_search first with keywords for this tool, then call it in a later step.`;

/** 始终完整加载、不进目录的工具（内置工具）。 */
export const isAlwaysLoaded = (key: string): boolean =>
  (BUILTIN_TOOL_NAMES as readonly string[]).includes(key);

type CatalogTool = Pick<ResolvedTool, "key" | "spec">;

/** 分词：切开驼峰，按非字母数字切分，转小写。 */
export function tokenize(text: string): string[] {
  return text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== "");
}

/**
 * 关键词评分（确定性）：对每个不同的查询词，`idf × (key 中出现 ? 2 : 0 + 描述中出现 ? 1 : 0)`，
 * `idf = ln(1 + N / df)`（df = 含该词的工具数）。只看是否出现、不按长度归一，描述长短不影响排名。
 * 分数为 0 的不返回；按分数降序，同分按 key 升序。
 */
export function searchTools<T extends CatalogTool>(
  query: string,
  tools: readonly T[],
  limit: number,
): T[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const docs = tools.map((t) => ({
    tool: t,
    key: new Set(tokenize(t.key)),
    desc: new Set(tokenize(t.spec.description)),
  }));
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const term of terms) {
    const df = docs.filter((d) => d.key.has(term) || d.desc.has(term)).length;
    idf.set(term, df === 0 ? 0 : Math.log(1 + n / df));
  }
  return docs
    .map((d) => {
      let score = 0;
      for (const term of terms) {
        const w = (d.key.has(term) ? KEY_WEIGHT : 0) + (d.desc.has(term) ? 1 : 0);
        score += w * (idf.get(term) ?? 0);
      }
      return { tool: d.tool, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.tool.key < b.tool.key
          ? -1
          : a.tool.key > b.tool.key
            ? 1
            : 0,
    )
    .slice(0, limit)
    .map((x) => x.tool);
}

/** 目录行：`- <key>: <描述的第一行>`（超长截断）。 */
export function catalogLine(t: CatalogTool): string {
  const first =
    t.spec.description
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  const desc =
    first.length > MAX_CATALOG_DESCRIPTION
      ? `${first.slice(0, MAX_CATALOG_DESCRIPTION - 1)}…`
      : first;
  return `- ${t.key}: ${desc}`;
}

/** 目录全文：开头说明 + 按 key 排序的目录行。只依赖工具集合，与加载状态无关（缓存前缀稳定）。 */
export function catalogText(tools: readonly CatalogTool[]): string {
  const sorted = [...tools].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return [CATALOG_HEADER, ...sorted.map(catalogLine)].join("\n");
}

/** 一个工具的完整定义文本（tool_search 的结果）。 */
function definitionText(t: CatalogTool): string {
  return [
    `Tool: ${t.key}`,
    `Description: ${t.spec.description}`,
    `Input schema: ${JSON.stringify(t.spec.inputSchema)}`,
  ].join("\n");
}

interface SearchInput {
  query: string;
  limit?: number;
}

/** 显示摘要里的查询词上限（码点）：摘要整体须 ≤ 200 码点（`validateToolDisplay`）。 */
const DISPLAY_QUERY_MAX = 120;

/** 摘要里的查询词：压成一行，超长按码点截断加省略号。 */
function displayQuery(query: string): string {
  const one = query.replace(/\s+/g, " ").trim();
  const cps = [...one];
  return cps.length > DISPLAY_QUERY_MAX ? `${cps.slice(0, DISPLAY_QUERY_MAX - 1).join("")}…` : one;
}

/**
 * 内置工具 `tool_search`（spec 5.5）：在本次运行可用、但未直接加载的工具中按关键词搜索，返回完整定义，
 * 并在结果里带 `loadedTools`（管线写进 `tool_result.loadedTools`；已加载集合只由日志还原）。
 * 搜索范围来自管线传入的 `ctx.tools`（本步解析出的工具）；内置工具始终加载，不参与搜索。
 */
export function toolSearchTool(): BuiltinTool {
  return {
    spec: TOOL_SEARCH_SPEC,
    defaultPolicy: "allow",
    async run(input, ctx) {
      const { query, limit = DEFAULT_LIMIT } = input as SearchInput;
      const catalog = (ctx.tools ?? []).filter((t) => !isAlwaysLoaded(t.key));
      const found = searchTools(query, catalog, limit);
      const q = displayQuery(query);
      if (found.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No tools matched "${query}". Try other keywords, or check the tool catalog in the system prompt.`,
            },
          ],
          loadedTools: [],
          display: {
            summary: { zh: `搜索工具「${q}」· 无匹配`, en: `Searched tools for "${q}" · no match` },
          },
        };
      }
      const head = `Loaded ${found.length} tool${found.length === 1 ? "" : "s"}. You can call ${found.length === 1 ? "it" : "them"} from your next step.`;
      return {
        content: [{ type: "text", text: [head, ...found.map(definitionText)].join("\n\n") }],
        loadedTools: found.map((t) => t.key),
        display: {
          summary: {
            zh: `搜索工具「${q}」· 加载 ${found.length} 个`,
            en: `Searched tools for "${q}" · loaded ${found.length}`,
          },
        },
      };
    },
  };
}
