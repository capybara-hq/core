/** 内核 schema 视图（`KernelSchemaDb`）的注入令牌。 */
export const KERNEL_DB = Symbol("KERNEL_DB");

/** 当前配置的取值函数（`() => KernelConfig`，热更新后返回新配置）的注入令牌。 */
export const KERNEL_CONFIG = Symbol("KERNEL_CONFIG");

/** `ProviderRegistry` 的注入令牌。 */
export const PROVIDER_REGISTRY = Symbol("PROVIDER_REGISTRY");

/** `AgentsService` 的注入令牌。 */
export const AGENTS = Symbol("AGENTS");

/** `AgentTemplatesService` (agent templates from plugins). */
export const AGENT_TEMPLATES = Symbol("AGENT_TEMPLATES");

/** `EventLog` 的注入令牌。 */
export const EVENT_LOG = Symbol("EVENT_LOG");

/** `ConversationsService` 的注入令牌。 */
export const CONVERSATIONS = Symbol("CONVERSATIONS");

/** `AttachmentsService`（对话附件）的注入令牌。 */
export const ATTACHMENTS = Symbol("ATTACHMENTS");

/** `InboxService`（收件箱汇总）的注入令牌。 */
export const INBOX = Symbol("INBOX");

/** `ConversationOutputs`（网页读工具输出存档）的注入令牌。 */
export const CONVERSATION_OUTPUTS = Symbol("CONVERSATION_OUTPUTS");

/** `ConversationArtifacts`（产物下载）的注入令牌。 */
export const CONVERSATION_ARTIFACTS = Symbol("CONVERSATION_ARTIFACTS");

/** `ConversationFiles` (file outputs list and text content, UI refresh B). */
export const CONVERSATION_FILES = Symbol("CONVERSATION_FILES");
export const FILE_PREVIEWERS = Symbol("FILE_PREVIEWERS");

/** `ConversationQueue` (queued messages, UI refresh B). */
export const CONVERSATION_QUEUE = Symbol("CONVERSATION_QUEUE");

/** `ConversationSandboxStatus`（对话沙箱状态）的注入令牌。 */
export const CONVERSATION_SANDBOX = Symbol("CONVERSATION_SANDBOX");
/** `ConversationToolInfo` (tool titles, kinds and key arguments for the conversation page). */
export const CONVERSATION_TOOLS = Symbol("CONVERSATION_TOOLS");

/** `ConversationStreams`（本进程持有的会话 SSE 连接）的注入令牌。 */
export const CONVERSATION_STREAMS = Symbol("CONVERSATION_STREAMS");

/** 连接器凭据（`Credentials`）的注入令牌。 */
export const CREDENTIALS = Symbol("CREDENTIALS");

/** `ToolRegistry` 的注入令牌。 */
export const TOOL_REGISTRY = Symbol("TOOL_REGISTRY");

/** `ConnectorsService` 的注入令牌。 */
export const CONNECTORS = Symbol("CONNECTORS");

/** `ConnectorContent`（连接器的 prompts / resources，供斜杠命令与 @ 引用）的注入令牌。 */
export const CONNECTOR_CONTENT = Symbol("CONNECTOR_CONTENT");

/** `ApprovalsService`（工具调用审批与授权）的注入令牌。 */
export const APPROVALS = Symbol("APPROVALS");

/** `QuestionsService`（工具调用的输入请求）的注入令牌。 */
export const QUESTIONS = Symbol("QUESTIONS");

/** `OAuthFlow`（OAuth 授权码连接流程）的注入令牌。 */
export const OAUTH_FLOW = Symbol("OAUTH_FLOW");

/** `ChannelConnections`（组织的渠道连接）的注入令牌。 */
export const CHANNEL_CONNECTIONS = Symbol("CHANNEL_CONNECTIONS");

/** `UiViews`（插件视图：列出贡献、render / action）的注入令牌。 */
export const UI_VIEWS = Symbol("UI_VIEWS");
/** `EmbedTokens`（嵌入应用的短期令牌，签发 / 校验）的注入令牌。 */
export const EMBED_TOKENS = Symbol("EMBED_TOKENS");

/** `OrgUiStreams`（组织级界面刷新 SSE）的注入令牌。 */
export const ORG_UI_STREAMS = Symbol("ORG_UI_STREAMS");

/** `TrajectoryService`（轨迹查看器）的注入令牌。 */
export const TRAJECTORIES = Symbol("TRAJECTORIES");

/** `EvalSetsService`（评测集与用例）的注入令牌。 */
export const EVAL_SETS = Symbol("EVAL_SETS");

/** `EvalRunsService`（评测运行）的注入令牌。 */
export const EVAL_RUNS = Symbol("EVAL_RUNS");

/** The enterprise catalog (`CatalogService`). */
export const CATALOG = Symbol("CATALOG");
/** Plugin (app bundle) import: prepare / confirm and staging cleanup (`PluginImport`). */
export const PLUGIN_IMPORT = Symbol("PLUGIN_IMPORT");
/** Marketplaces (`MarketplacesService`). */
export const MARKETPLACES = Symbol("MARKETPLACES");
/** Organizations browse and install from the enterprise catalog (`OrgCatalogService`). */
export const ORG_CATALOG = Symbol("ORG_CATALOG");
/** Catalog requests and approvals (`CatalogRequestsService`). */
export const CATALOG_REQUESTS = Symbol("CATALOG_REQUESTS");
/** Org install and uninstall of plugins (app bundles) (`PluginInstaller`). */
export const PLUGIN_INSTALLER = Symbol("PLUGIN_INSTALLER");
