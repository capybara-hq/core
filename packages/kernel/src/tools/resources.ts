import {
  type ConnectorSession,
  ToolError,
  type ToolResult,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";

/**
 * 应用 resources 的两个内核工具（brief：`<appSlug>__list_resources`、`<appSlug>__read_resource {uri}`）。
 *
 * 设计：安装 / 刷新应用时，连接器会话带 `listResources` 方法即视为支持 resources（不额外调用，免得多一次外连
 * 和多一种失败），内核把这两个工具作为 `source = 'resources'` 的行写进 `app_tools`（迁移 0013）。这样它们和
 * 连接器工具走同一套机制：管理员可启停、改默认策略，agent 可点名引用或随 `tools: "all"` 带上，策略 / 授权 /
 * 审批按 key 与指纹生效；执行时管线按 `source` 路由到会话的 `listResources` / `readResource`。
 * 只读注解 → 默认 `allow`。连接器自己有同名工具时连接器的优先，内核的那个不加并报原因。
 */

export const LIST_RESOURCES = "list_resources";
export const READ_RESOURCE = "read_resource";

/** 两个工具的定义（与 slug 无关，指纹稳定）。 */
export function resourceToolSpecs(): ToolSpec[] {
  return [
    {
      name: LIST_RESOURCES,
      description:
        "List the resources (documents, files, records) this app exposes. Returns a JSON array of { uri, name, description?, mimeType? }; read one with this app's read_resource tool.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: READ_RESOURCE,
      description:
        "Read the content of one of this app's resources by its URI (get URIs from this app's list_resources tool).",
      inputSchema: {
        type: "object",
        properties: { uri: { type: "string", description: "Resource URI from list_resources" } },
        required: ["uri"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ];
}

const NOT_SUPPORTED =
  "This app no longer supports resources; ask an administrator to refresh the app.";

/** 执行 resources 工具：路由到会话的 listResources / readResource。 */
export async function runResourceTool(
  session: ConnectorSession,
  name: string,
  input: unknown,
): Promise<ToolResult> {
  if (name === LIST_RESOURCES) {
    if (!session.listResources) throw new ToolError(NOT_SUPPORTED);
    const items = await session.listResources();
    return {
      content: [
        {
          type: "text",
          text: items.length === 0 ? "This app exposes no resources." : JSON.stringify(items),
        },
      ],
    };
  }
  if (name === READ_RESOURCE) {
    if (!session.readResource) throw new ToolError(NOT_SUPPORTED);
    const uri = (input as { uri?: unknown } | null)?.uri;
    if (typeof uri !== "string" || uri === "")
      throw new ToolError("uri must be a non-empty string.");
    return session.readResource(uri);
  }
  throw new ToolError(`Unknown resource tool ${name}.`);
}
