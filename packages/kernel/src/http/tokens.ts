/** 内核 schema 视图（`KernelSchemaDb`）的注入令牌。 */
export const KERNEL_DB = Symbol("KERNEL_DB");

/** 当前配置的取值函数（`() => KernelConfig`，热更新后返回新配置）的注入令牌。 */
export const KERNEL_CONFIG = Symbol("KERNEL_CONFIG");

/** `ProviderRegistry` 的注入令牌。 */
export const PROVIDER_REGISTRY = Symbol("PROVIDER_REGISTRY");

/** `InboxService`（收件箱汇总）的注入令牌。 */
export const INBOX = Symbol("INBOX");

export const FILE_PREVIEWERS = Symbol("FILE_PREVIEWERS");

/** `ConversationToolInfo` (tool titles, kinds and key arguments for the conversation page). */
export const CONVERSATION_TOOLS = Symbol("CONVERSATION_TOOLS");

/** `ChannelConnections`（组织的渠道连接）的注入令牌。 */
export const CHANNEL_CONNECTIONS = Symbol("CHANNEL_CONNECTIONS");

/** `UiViews`（插件视图：列出贡献、render / action）的注入令牌。 */
export const UI_VIEWS = Symbol("UI_VIEWS");
/** `EmbedTokens`（嵌入应用的短期令牌，签发 / 校验）的注入令牌。 */
export const EMBED_TOKENS = Symbol("EMBED_TOKENS");

/** `OrgUiStreams`（组织级界面刷新 SSE）的注入令牌。 */
export const ORG_UI_STREAMS = Symbol("ORG_UI_STREAMS");

/** `EvalSetsService`（评测集与用例）的注入令牌。 */
export const EVAL_SETS = Symbol("EVAL_SETS");

/** `EvalRunsService`（评测运行）的注入令牌。 */
export const EVAL_RUNS = Symbol("EVAL_RUNS");
