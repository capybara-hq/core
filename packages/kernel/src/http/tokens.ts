/** 内核 logger（`Logger`）的注入令牌。 */
export const KERNEL_LOG = Symbol("KERNEL_LOG");

/** 健康检查参数（`HealthOptions`）的注入令牌。 */
export const HEALTH_OPTIONS = Symbol("HEALTH_OPTIONS");

/** 内核 schema 视图（`KernelDb`）的注入令牌。 */
export const KERNEL_DB = Symbol("KERNEL_DB");

/** 内核共享 Redis 连接（ioredis `Redis`）的注入令牌。 */
export const KERNEL_REDIS = Symbol("KERNEL_REDIS");

/** 当前配置的取值函数（`() => KernelConfig`，热更新后返回新配置）的注入令牌。 */
export const KERNEL_CONFIG = Symbol("KERNEL_CONFIG");

/** `AccountsService` 的注入令牌。 */
export const ACCOUNTS = Symbol("ACCOUNTS");

/** `SessionService` 的注入令牌。 */
export const SESSIONS = Symbol("SESSIONS");

/** `ApiTokenService` 的注入令牌。 */
export const API_TOKENS = Symbol("API_TOKENS");

/** `SettingsService` 的注入令牌。 */
export const SETTINGS = Symbol("SETTINGS");

/** `LoginRateLimiter` 的注入令牌。 */
export const RATE_LIMITER = Symbol("RATE_LIMITER");

/** `OrgsService` 的注入令牌。 */
export const ORGS = Symbol("ORGS");

/** `OrgSettingsService`（组织设置）的注入令牌。 */
export const ORG_SETTINGS = Symbol("ORG_SETTINGS");

/** `MembersService` 的注入令牌。 */
export const MEMBERS = Symbol("MEMBERS");

/** `InvitationsService` 的注入令牌。 */
export const INVITATIONS = Symbol("INVITATIONS");

/** `SetupService` 的注入令牌。 */
export const SETUP = Symbol("SETUP");

/** Injection token for `OrgExtensionConfigs`. */
export const ORG_PLUGIN_CONFIGS = Symbol("ORG_PLUGIN_CONFIGS");

/** `ProviderRegistry` 的注入令牌。 */
export const PROVIDER_REGISTRY = Symbol("PROVIDER_REGISTRY");

/** `AgentsService` 的注入令牌。 */
export const AGENTS = Symbol("AGENTS");

/** 内核总线（`createBus(..., "kernel")`，`ExtensionContext["bus"]`）的注入令牌。 */
export const KERNEL_BUS = Symbol("KERNEL_BUS");

/** `EventLog` 的注入令牌。 */
export const EVENT_LOG = Symbol("EVENT_LOG");

/** `ConversationsService` 的注入令牌。 */
export const CONVERSATIONS = Symbol("CONVERSATIONS");

/** `AttachmentsService`（对话附件）的注入令牌。 */
export const ATTACHMENTS = Symbol("ATTACHMENTS");

/** `SkillsService`（技能库）的注入令牌。 */
export const SKILLS = Symbol("SKILLS");

/** `SkillChangesService`（agent 自写技能与技能变更审批）的注入令牌。 */
export const SKILL_CHANGES = Symbol("SKILL_CHANGES");

/** `InboxService`（收件箱汇总）的注入令牌。 */
export const INBOX = Symbol("INBOX");

/** `ConversationOutputs`（网页读工具输出存档）的注入令牌。 */
export const CONVERSATION_OUTPUTS = Symbol("CONVERSATION_OUTPUTS");

/** `ConversationArtifacts`（产物下载）的注入令牌。 */
export const CONVERSATION_ARTIFACTS = Symbol("CONVERSATION_ARTIFACTS");

/** `ConversationSandboxStatus`（对话沙箱状态）的注入令牌。 */
export const CONVERSATION_SANDBOX = Symbol("CONVERSATION_SANDBOX");

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

/** `ExternalIdentities`（外部身份 ↔ 账号）的注入令牌。 */
export const EXTERNAL_IDENTITIES = Symbol("EXTERNAL_IDENTITIES");

/** `IdentityBinding`（IM 身份的一次性绑定链接）的注入令牌。 */
export const IDENTITY_BINDING = Symbol("IDENTITY_BINDING");

/** `SsoFlow`（第三方登录）的注入令牌。 */
export const SSO_FLOW = Symbol("SSO_FLOW");

/** `Offboarding`（成员离职处理）的注入令牌。 */
export const OFFBOARDING = Symbol("OFFBOARDING");

/** `ChannelConnections`（组织的渠道连接）的注入令牌。 */
export const CHANNEL_CONNECTIONS = Symbol("CHANNEL_CONNECTIONS");

/** `DirectorySync`（通讯录同步）的注入令牌。 */
export const DIRECTORY_SYNC = Symbol("DIRECTORY_SYNC");

/** `UiViews`（插件视图：列出贡献、render / action）的注入令牌。 */
export const UI_VIEWS = Symbol("UI_VIEWS");
/** `EmbedTokens`（嵌入应用的短期令牌，签发 / 校验）的注入令牌。 */
export const EMBED_TOKENS = Symbol("EMBED_TOKENS");

/** `OrgUiStreams`（组织级界面刷新 SSE）的注入令牌。 */
export const ORG_UI_STREAMS = Symbol("ORG_UI_STREAMS");

/** `PricesService`（模型价格表）的注入令牌。 */
export const PRICES = Symbol("PRICES");

/** `TrajectoryService`（轨迹查看器）的注入令牌。 */
export const TRAJECTORIES = Symbol("TRAJECTORIES");

/** `EvalSetsService`（评测集与用例）的注入令牌。 */
export const EVAL_SETS = Symbol("EVAL_SETS");

/** `EvalRunsService`（评测运行）的注入令牌。 */
export const EVAL_RUNS = Symbol("EVAL_RUNS");

/** `ModelPurposesService`（模型用途映射）的注入令牌。 */
export const MODEL_PURPOSES = Symbol("MODEL_PURPOSES");

/** Injection token for `ExtensionInstalls` (extension package imports and install records). */
export const PLUGIN_INSTALLS = Symbol("PLUGIN_INSTALLS");
/** Injection token for `ExtensionAdmin` (deployment-level extension list, status and web approval, enterprise admins). */
export const PLUGIN_ADMIN = Symbol("PLUGIN_ADMIN");
/** Deployment-level extension install / enable / disable / uninstall (`ExtensionAdminOps`). */
export const PLUGIN_ADMIN_OPS = Symbol("PLUGIN_ADMIN_OPS");
/** Deployment-level extension config (`ExtensionDeploymentConfigService`). */
export const PLUGIN_DEPLOYMENT_CONFIGS = Symbol("PLUGIN_DEPLOYMENT_CONFIGS");
/** 企业目录（`DirectoryService`）。 */
export const DIRECTORY = Symbol("DIRECTORY");
/** 应用包导入（AppImport）。 */
export const APP_IMPORT = Symbol("APP_IMPORT");
/** 目录来源（`CatalogsService`）。 */
export const CATALOGS = Symbol("CATALOGS");
/** 组织从企业目录浏览与安装（`OrgDirectoryService`）。 */
export const ORG_DIRECTORY = Symbol("ORG_DIRECTORY");
/** 目录申请与审批（`DirectoryRequestsService`）。 */
export const DIRECTORY_REQUESTS = Symbol("DIRECTORY_REQUESTS");
/** 应用的组织安装与卸载（`AppInstaller`）。 */
export const APP_INSTALLER = Symbol("APP_INSTALLER");
