---
name: writing-channels
description: 新建或修改 IM 渠道、第三方登录、通讯录插件时使用（provides channel@1 / identity-source@1 / directory@1，如 plugins/slack、plugins/lark）：入站事件的 messageId / threadId / tenantId 约定、去掉 @ 机器人、只处理文本、onEvent resolve 后才 ack、card_action 的 eventId 与卡片目标、locale、ChannelSendError 的 retryable / reason、features 与 minEditIntervalMs、拆分返回最后一条 id、idempotencyKey；卡片规范（validateChannelCard、renderCardAsText、questionRenderableInline、按钮回传值）；防 @所有人与链接白名单；长连接与选主（含插件停用 / 升级时 supervisor 停掉旧实例的长连接）、持久入站 / 出站、去重、卡片操作复核由内核负责；自管重连；身份源键 <插件>:<租户>、PKCE、ID token；通讯录分页、configured()、不完整必须报错、大批移除保护；以及用 startFakeChannelServer / startFakeSlack / startFakeLark 与双副本写测试。
---

# 写渠道、登录与通讯录插件

一个 IM 平台通常由一个插件同时提供三种能力，三处共用**同一个身份键**：

| 能力 | 契约 | 配置层级 | 是否按组织启用 |
|---|---|---|---|
| `channel@1`（机器人） | `packages/plugin-sdk/src/channel.ts`、卡片 `cards.ts` | 每个**渠道连接**一份（`connectionSchema`，组织管理员在网页「渠道」里建） | 是（`orgScoped`） |
| `identity-source@1`（网页登录） | `identity.ts` | **部署级**（`config.deployment`，经 `auth.loginSources` 启用） | 否（Ruling P1） |
| `directory@1`（通讯录） | `directory.ts` | **组织级**（`config.org`） | 是（`orgScoped`） |

通用的插件写法（清单、两级配置、多副本禁令、权限批准）见 `.agents/skills/writing-plugins`，这里只讲这三种能力特有的部分。

参考实现：

- `plugins/slack`：Socket Mode、Block Kit、Sign in with Slack（OIDC，校验 ID token）、`users.list` 通讯录。
- `plugins/lark`：Lark 长连接（官方 SDK `WSClient`）、JSON 2.0 交互卡片、OAuth 授权码 + PKCE、按部门遍历通讯录。
- `packages/kernel/test/fixtures/plugins/fake-im`：最小形状（连 `startFakeChannelServer`），先读它再读真实插件。

两个插件的 README（`plugins/slack/README.md`、`plugins/lark/README.md`）逐条写了平台文档出处与每个取舍，写新平台时照这个粒度写。

## 身份键（先看这个）

- `identities.source` = `"<插件名>:<租户 id>"`，`external_id` = 平台用户 id。登录、渠道入站、通讯录三处必须得出**同一个**键，同一个人只对应一行身份、一个账号（Slack：`slack:<team id>` + `U…`；Lark：`lark:<tenant_key>` + `open_id`）。
- 租户的口径要在三处一致：`verify` 返回的 `tenantId`、入站 `sender.tenantId`、`ExternalIdentity.tenantId`、`DirectoryMember.tenantId`。Slack 取 team id（Enterprise Grid 下是工作区 team，**不是** enterprise `E…`，否则同一人被拆成两行）；Lark 取 `tenant_key`。
- 平台用户 id 按应用区分的平台（Lark 的 `open_id`）：登录、机器人、通讯录必须是同一个应用，插件要尽量自动核对（见 Lark README）。

## `channel@1`

```ts
interface Channel {
  connectionSchema: ZodTypeAny;            // 密钥字段用 secret()
  features: { cards: boolean; edit: boolean; threads: boolean; minEditIntervalMs?: number };
  verify(args): Promise<{ botUserId; botName; tenantId }>;
  connect(args: ChannelConnectArgs): Promise<void>;   // 长连接循环
  send(args: ChannelSendArgs): Promise<{ messageId: string }>;
  update(args: ChannelSendArgs & { messageId: string }): Promise<void>;
}
```

### 入站事件（`InboundEvent`）的约定

- **`messageId` 在本连接内唯一且稳定**（平台重投时相同）：内核按它去重。Slack 用 `<频道>:<ts>`，Lark 用 `message_id`。
- **群聊 `target.threadId` = 话题根消息的 `messageId`**（与根消息入站时的 `messageId` 完全相同的串），不是平台另外的话题 id（Lark 是 `root_id` 的 `om_…`，不是 `thread_id` 的 `omt_…`）。消息不在话题里时不带 `threadId`：内核用这条消息的 `messageId` 当话题键，回复投进以它为根的话题，于是后续回复落到同一个会话。私聊不带。
- **`sender.tenantId`** 为发言人所属企业（同上口径）。与连接租户不同的人（外部联系人、共享频道里的别家企业、Slack Grid 其他工作区）内核**只允许绑定**，即使连接开了匿名访客也不按匿名处理。
- **`sender.displayName` / `avatarUrl`**：拿得到就带（Slack 取事件自带的 `user_profile`，否则 `users.info`；Lark 取用户信息接口）。查询要有短超时，查不到就不带，不能因此拖过平台的确认时限。内核把显示名放在绑定确认页（防钓鱼），没有时回落到 `externalId`。
- **`text` 去掉 @ 机器人**，`mentionsBot` 另行说明是否 @ 了；只整理 @ 两侧的空格，换行与缩进保留（代码块不能被压坏）。其他人的 @ 换成可读的 `@名字`。
- **M4 只处理文本**：图片、文件等附件忽略，消息只有附件时不发事件（带说明文字的文件分享只取文字）。
- **编辑、撤回 / 删除不发事件**；机器人自己与其他机器人的消息忽略。
- 群聊里插件如实转发话题回复（`mentionsBot: false` 也转发），**内核目前只处理 @ 了机器人的群消息**（D4），话题跟进需要再 @。
- **`card_action`**：`messageId` = 卡片所在消息的 id（同一张卡片多次点击相同）；`eventId` = 平台给这次点击的唯一 id，拿得到就带（Slack `<频道>:<卡片 ts>:<点击者>:<action_ts>`，Lark 回调 `header.event_id`），内核按它去重平台重投；群聊里 `target.threadId` 拿得到就带，拿不到时内核取发出卡片时记下的话题。
- **`target.chatType` 在卡片点击里只是参考值**：内核先核对点击所在 chat 与发卡片时记下的目标（`channel_card_messages`）一致，再按**记下的**会话类型、chat、话题解析点击者与回复。不一致只回「不能处理」，不解析发言人、不发绑定链接。所以按钮回传值里的会话类型被篡改或卡片被转发都无效。
- `directory_changed`：平台推人员变动（Slack `team_join` / `user_change`，Lark `contact.user.*_v3`）时发 `{ type: "directory_changed", tenantId }`，内核按分钟合并后触发一次通讯录同步。

### `connect` 与确认（ack）

- `onEvent` 由内核实现：只做去重（`message` 按 `messageId`、带 `eventId` 的 `card_action` 按 `eventId`，各 24 小时）并把事件持久地排进队列 `cap-kernel-channels`，很快返回。**resolve 即内核已可靠收下**。
- 插件**在 `onEvent` resolve 之后才向平台确认**；reject 时**不要确认**（Lark 处理函数重新抛出，SDK 回 500），让平台重投。插件不自己重试 `onEvent`，也不在 `onEvent` 前做慢事（资料查询要有短超时，平台确认时限 Slack / Lark 都只有几秒）。
- 被忽略的事件直接确认。
- `connect` 只在 `signal` 中止时返回。抛错或提前返回，内核都记连接的 `last_error`，指数退避（`channels.retryBaseMs` 起翻倍，上限 5 分钟）后由任一副本重试。

### 重连

- SDK 自带的重连如果吞掉错误（Slack SDK 3.1.0 把 `apps.connections.open` 的失败变成未处理的拒绝；Lark SDK 按服务端下发的长间隔静默重试、不回到调用方），**关掉它，自己写循环**：平台正常回收连接时立即重连；连接失败或连续短命（不到 10 秒）按指数退避**加抖动**；连续 5 次、或平台明确拒绝（凭据错误、`link_disabled`、超过连接数上限）时**抛错**，让内核记 `last_error` 并接管退避。
- 等待用可中止的 `AbortSignal.timeout`（见 `plugins/lark/src/wait.ts` 的 `pause`），不能用 `setTimeout`（`check:plugin-state` 的 `plugin-timer`）。
- `signal` 中止时关掉 socket 再返回；中止发生在建连途中也要检查 `signal.aborted` 并断开（否则泄漏连接）。

### `send` / `update`

- `message.text` 是 Markdown，转成平台原生富文本，**不翻译**。超过平台单条上限时插件自行拆成多条按序发送，**返回最后一条的 id**（内核之后编辑的是这条）。
- `update` 的新文本超过单条上限、无法改成一条 → 抛不可重试的 `ChannelSendError`，`reason: "too_large"`：内核改为把完整文本作为新消息 `send`（由插件拆分）。`features.edit` 为 false 的渠道不会被调用 `update`；卡片状态变化时内核另发一条新卡片，旧卡片的按钮仍可点，内核回「已处理」。
- `features.minEditIntervalMs`：平台允许的同一条消息两次编辑的最小间隔，内核流式草稿的更新间隔取 `max(1000, minEditIntervalMs)`（Slack 2500，Lark 1500）。更高并发靠限流错误 + 退避兜底。
- `locale`（`"zh" | "en"`，组织设置的 IM 语言）：插件自己渲染的固定词（按钮、降级文本）按它选。
- `idempotencyKey`（可选）：不超过 40 个 `[A-Za-z0-9_-]` 字符（内核实际给 32 个），同一条逻辑消息的每次重试都相同。平台支持幂等发送时透传（Lark `uuid`；拆成多条时第 i 条用 `<key>-<i>`），不支持的忽略（Slack）。
- `features.cards` 为 false 的渠道，内核先把每张卡片按 `renderCardAsText(card, locale)` 退回为文本、以空行分隔拼在正文之后，交给插件的消息不带 `cards`（Ruling A33，`packages/kernel/src/channels/features.ts`）。退回文本是 **Markdown**（与 `message.text` 一样由插件转换成原生富文本），模型可控的字段（审批标题、输入预览、提问标题、回答摘要）放在行内代码 / 围栏代码块里，不会变成链接；插件的转换器必须让代码内容按原样显示。声明 `cards: true` 的插件收到 `message.cards`，自己渲染原生卡片；某张卡片渲染不了（如按钮回传值超限）时插件自己退回链接或文本。
- `features.threads` 为 false 的渠道（平台没有话题），内核交给插件的目标不带 `threadId`，回复直接发在 chat 里。入站事件一般也不带 `threadId`（平台本来就没有话题可填）；不带时群里每条 @ 消息各开一个对话。
- `features.edit` 为 false 时不发流式草稿，只在定稿时发一条（见上）。

### 失败分类（`ChannelSendError`）

| 情况 | 抛 | 内核怎么做 |
|---|---|---|
| 限流、平台 5xx、网络、超时 | `retryable: true`，带平台给的 `retryAfterMs` | 退避后重试（有次数上限） |
| 凭据失效、权限被收回、应用停用 | `retryable: false, reason: "auth"` | 记连接 `last_error`，停止该会话本轮投递 |
| 机器人被移出群、群解散、用户不可达 | `reason: "target_gone"` | 停止该会话本轮投递，不计入毒事件 |
| 内容被平台拒绝 | `reason: "rejected"`（未给原因按它处理） | 同一事件失败满 3 次跳过它，并尽力回一句「请到网页上处理」 |
| 拆分后仍超限 / 编辑超长 | `reason: "too_large"` | 同上；`update` 时改发新消息 |

其他异常内核按可重试处理（次数有限）。判断用 `isChannelSendError`（鸭子类型，不用 `instanceof`）。错误消息只带步骤与平台错误码，**不带令牌、请求头或响应体**（`cause` 可挂原错误，但原错误本身也不能含凭据，见 Lark 的 header-free 错误）。

## 卡片规范（`cards.ts`）

`ChannelCard` 由内核产出，插件按各 IM 的原生格式渲染：

| `kind` | 内容 | 交互 |
|---|---|---|
| `approval` | 标题、工具 / 连接器、agent、参数预览（内核已按键名与连接密钥打码，≤500 字符）、可选范围 `scopes`、`expiresAt`、`state`、`decidedBy`、`webUrl` | `pending` 时每个范围一个批准按钮 + 拒绝 + 网页链接；其他状态去掉按钮，只显示状态与「详情」链接 |
| `question` | `form`（`InputForm`）、`state`、`answerSummary`、`webUrl` | `questionRenderableInline(form)` 为真（恰一个枚举字段，单选 ≤5 / 多选 ≤10，不允许「其他」）时在 IM 内作答，否则只给网页链接 |
| `connect` | `appName`、`url` | 链接按钮 |
| `bind` | `text`、`url` | 链接按钮（内核只在私聊里发） |

- 结构用 `validateChannelCard(card)` 校验（返回问题列表）；URL 字段必须是 http(s) 绝对地址且不超过 2000 字符。
- 退回文本统一用 `renderCardAsText(card, locale)`（Markdown，含链接；模型可控字段在代码里），不要自己另写一套；声明 `cards: false` 时内核已替你做了。
- 卡片操作解析成 `CardAction { cardKind, cardId, action, scope?, answer? }`。**按钮回传值**：把需要的信息（卡片 id、动作、范围、选项值）编码进按钮本身（紧凑 JSON 数组），插件不记发出的表单，任一副本都能解析；编码超过平台上限（Slack 2000，Lark 没写明，取 2000）时抛错、改为只给网页链接；解析**严格**：长度、类型、种类、范围逐项核对，不合法返回 null 并忽略这次点击（只认本插件前缀的 action id）。
- 回传值里的会话类型只是参考（见上，内核以记下的卡片目标为准）；能关的话关掉卡片转发后的交互（Lark `enable_forward_interaction: false`）。
- 卡片点击的应答不改卡片：卡片随后由内核按审批 / 提问的新状态更新。

## 安全规则（每个渠道插件都要做）

- **模型文本不能 @ 所有人或任何人**：转换富文本时转义平台的控制序列。Slack：`&`、`<`、`>` 转义，链接地址里的 `<`、`>`、`|` 百分号编码，模型写不出 `<!channel>` / `<!here>` / `<@U…>`；Lark：代码之外的 `<` 与 `&` 转成实体、反斜杠转成 `&#92;`，代码里的 `<at` 拆开，模型写不出 `<at id=all>`。卡片里的标题、参数预览、显示名、退回文本同样转义（不只是正文）。
- **链接白名单**：只把 `http(s)://`（Lark 另加 `mailto:`）做成链接；`javascript:`、平台私有协议、图片与引用式链接按普通文字显示。卡片的链接按钮只用 http(s) 地址。
- **凭据不进日志与错误**：令牌、App Secret、client secret 不写进日志、错误消息、`last_error`。部署级 `secret()` 字段与渠道连接的密钥字段内核会登记打码，但打码只是兜底。
- 凭据都由内核按配置传入（`config` 参数），插件**不需要 `permissions.secrets`**；`permissions.network` 列出固定域名（只展示、不拦截，不支持通配，WSS 主机由平台分配时列主要的一个或不列）。

## 内核负责什么（插件不要做）

- **长连接与选主**：runs only on the gateway role (outbound delivery and inbound jobs stay on the worker role)。每个渠道连接任一时刻只由一个副本持有（Redis 租约 `capk:channel-lease:<id>`，TTL `channels.leaseTtlMs` 默认 30s，`channels.scanIntervalMs` 默认 10s 续租与扫描）；持有者死了，另一副本在租约过期后接管；连接被停用、删除或轮换凭据时持有者断开、按新配置重连。插件的 `connect` 只管一条连接，不判断「该不该由我连」。**插件在运行中被停用、卸载或升级换实例时（C17）**，内核的 `ChannelSupervisor.pluginChanged` 交还该插件在本副本持有的全部长连接：中止旧实例 `connect` 的 `signal`、等它返回后释放租约；插件仍在（新实例）时下一轮扫描由任一副本按新实例重新选主，已撤销的不再连接。所以 `connect` 必须及时响应 `signal` 并返回，不要吞掉中止继续重连。
- **持久入站与出站**：入站在队列里处理（失败退避重试共 5 次），出站按会话事件序号（`channel_deliveries.last_seq`）续投，崩溃后由别的副本接着投、不重复；流式草稿、定稿、卡片状态更新都由内核编排。
- **去重**：入站按 `messageId` / `eventId`，出站按 `idempotencyKey` 与已投递序号。
- **卡片操作的再授权**：点击者按入站同样的规则映射到账号，再走审批 / 提问服务的授权（不是审批人只回一句说明，未绑定的人在私聊里收到绑定卡片、群里只提示去私聊）。
- **身份解析、绑定、匿名访客、固定话术**（i18n，按组织 `locale`）。

所以插件**不得保存跨调用的共享状态**（模块级 Map、进程内事件、定时器都不行，`check:plugin-state` 会拦）。允许的进程内缓存只有「丢了也对」的只读查询缓存，在工厂函数里创建、有大小上限与过期（如显示名缓存 10 分钟 / 1000 人，tenant token 缓存到过期前 3 分钟）。

## `identity-source@1`

```ts
interface IdentitySource {
  label: { zh: string; en: string };
  authorizeUrl(args: { config; redirectUri; state; nonce; codeChallenge?; codeChallengeMethod? }): string;
  callback(args: { config; redirectUri; query; nonce; signal; codeVerifier? }): Promise<ExternalIdentity>;
}
```

- 部署级：`config` 是 `config.deployment`，管理员把插件名加进 `auth.loginSources` 后登录页才出现。回调地址 `<http.publicUrl>/api/v1/auth/sso/<插件名>/callback`。
- state、nonce、PKCE verifier 都由内核生成并存在 Redis（state 单次有效、绑定发起登录的浏览器）。
- **`source` 必须是 `` `${插件名}:${tenantId}` ``**：内核在回调后核对，不一致按身份源出错拒绝（Ruling A19）。
- **`externalId` 必须与该平台渠道入站的 `sender.externalId` 是同一种 id**（同一个应用、同一个口径），否则登录和机器人对不上人。
- **`emailVerified` 只在平台文档明确说明邮箱已验证时为 true**（Slack OIDC 的 `email_verified`）；文档没说就报 false（Lark 登录与两家的通讯录都是 false）。它决定能否按邮箱合并既有账号。
- **平台支持 PKCE 就用**：把 `codeChallenge` / `codeChallengeMethod` 放进授权地址，换 token 时带 `codeVerifier`（Lark）。不支持就忽略并在 README 写明理由（Slack OIDC 没有声明 PKCE）。
- **有 ID token 就校验**：JWKS 验签、`iss`、`aud = clientId`、未过期、`nonce` 与发起时一致；userinfo 的用户 / 租户必须与 ID token 一致。没有 ID token 的（Lark）核对用户的租户等于登录应用的租户，`redirect_uri` 严格一致。
- 只申请登录真正需要的 scope：申请应用没开通的 scope 会让所有人登录失败（Lark 20027），所以 Lark 登录不带 scope（Ruling A31）。
- 登录只建账号、不加入任何组织；按已验证邮箱合并只对 `auth.trustedIdentitySources` 里的完整键 `<插件名>:<租户>` 生效。

## `directory@1`

```ts
interface Directory {
  configured?(orgConfig: unknown): boolean;
  listMembers(args: { orgConfig; cursor?; signal }): Promise<{ members: DirectoryMember[]; next?: string }>;
}
```

- **分页**：每次调用返回一页与下一页游标 `next`，最后一页不带 `next`。内核每页 60 秒时限、一轮最多 10000 页。游标里放续页需要的一切（插件无状态）。
- **`configured(orgConfig)`**（Ruling A28）：同一插件还提供渠道等能力、通讯录字段在组织级配置里可选时实现它。返回 false 时内核静默跳过每小时扫描、`directory_changed` 与移除前复核，手动同步返回 409 `directory.not_configured`。必须是纯函数（不发请求、不抛错）。
- **未配置或凭据不对时抛错，绝不返回空列表**：空列表等于「所有人都离职了」。
- **列不全就必须失败**：任何一页拿不全（权限不够、限流等待超预算、同步途中部门结构变了、租户在一轮里变了、状态字段因权限缺失拿不到）都抛错。内核只在整轮成功走完时才移除人；中途失败只加人不删人。不要「尽力返回能拿到的」。
- **限流**：在本页内按平台给的等待时长重试，累计等待有预算（两个插件都是每页 30 秒、每个请求最多 3 次），超出就抛「rate limited」，本轮按不完整处理。
- **`active: false`** 报离职（Slack `deleted`，Lark `is_resigned` / `is_frozen` / `is_exited`）；不是正式成员的人不报（Slack 访客 `is_restricted` / `is_ultra_restricted` 不同步，Ruling A29；Lark 未激活、未加入的不报；机器人、Slackbot 不报）。同一人出现多次没关系，内核按身份去重。
- 内核侧的保护（插件不用实现，但要知道）：
  - 只撤销 `memberships.source = "directory:<插件>"` 的成员关系；手动 / 邀请加入的人永远不被同步移除，账号本身不停用。
  - **大批移除保护**（Ruling A17）：非手动触发的一轮，计划移除数超过 `max(5, 20% × 现有通讯录成员数)`，或列表里没有在职成员而已有通讯录成员时，当作不完整、不移除，审计 `org.directory.removal_blocked`；手动同步不受此限。
  - **同步途中有变动**（Ruling A32）：一轮持锁期间又来了 `directory_changed` / 同步请求，这一轮不移除任何人（审计 `partialReason = changed_during_sync`），随后补跑的那一轮再移除。手动同步碰上锁被占时也是记下标记、由补跑（触发来源 `changed`）完成，所以那一轮仍受 A17 保护。
  - **排除名单**（Ruling A20 / A24）：管理员手动移出或本人离开时，对该组织启用的每个通讯录插件写排除记录，同步不再把此人加回，直到有人手动重新加入。

## 测试

假服务端都在 `@capybara-hq/testing`：

| 假服务端 | 扮演 | 构造入站事件 |
|---|---|---|
| `startFakeChannelServer()` | 通用假 IM：NDJSON 长连接、`/send` `/update`（按 `idempotencyKey` 去重）、OAuth（含 PKCE）、通讯录 `book(key)`；统计每个连接同时在线的长连接数峰值 | `fakeDm`、`fakeGroupMessage`、`fakeCardAction`、`fakeDirectoryMember`；`push(connectionId, event)` |
| `startFakeSlack()` | Web API、Socket Mode（记 `acks`）、Sign in with Slack（RS256 ID token，`tamperNextIdToken`）、`users.list`；`failNext` 注入平台错误 / 429 | `slackDmEvent`、`slackMentionEvent`、`slackBlockAction`、`findSlackButton` |
| `startFakeLark()` | OpenAPI、长连接（SDK 的 protobuf 帧，跑真实 `WSClient`，记 `acks`）、OAuth + PKCE、部门 / 用户分页；`failNext`、`hideUserStatus` | `larkMessageEvent`、`larkCardAction`、`findLarkButton` |

- **插件单测**（`plugins/<name>/test`）：直接调工厂函数（如 `createSlackChannel({ apiUrl })`）连假服务端，覆盖：入站各类消息的取舍与 id、去掉 @、ack 只在 `onEvent` resolve 后（reject 不 ack）、重连与退避、错误映射表、拆分与 `too_large`、转义（`@channel` / `<at id=all>` 注入）、链接白名单、按钮回传值的编码上限与严格解析、身份键与 ID token 篡改、通讯录分页 / 限流预算 / 未配置 / 列不全报错。
- **双副本内核验收**（`packages/kernel/test/channels/*.dual.test.ts`）：`createDualReplicaHarness({ plugins: [MODEL_FAKE, <插件入口路径>], pluginConfig: { <插件>: { apiUrl: fake.apiUrl, … } } })`，插件按源码路径加载。要证明：只有一条长连接；杀掉持有者后另一副本接管；同一条消息重投只处理一次；流式回复、审批卡片点击、卡片更新、最终回复都只投一次。参考 `slack.dual.test.ts`、`lark.dual.test.ts`、`supervisor.dual.test.ts`。
- **三处同一身份行**：`slack-identity.dual.test.ts`、`lark-identity.dual.test.ts` 的流程——网页登录（走假授权页、回调）→ 通讯录同步把同一个人加入组织（不另建身份、不另建账号）→ 同一个人私聊机器人被识别为该账号（不发绑定卡片）。新平台必须有这条用例，它能抓住租户口径、id 种类、应用不一致这类错误。
- 测试插件写法照抄 fake-im（`packages/kernel/test/fixtures/plugins/fake-im`）；第一段验收 `m4-segment1.dual.test.ts` 用它跑通了全部内核行为。
- 第二段验收 `m4-segment2-slack.dual.test.ts` / `m4-segment2-lark.dual.test.ts` 用真实插件把同一流程各跑一遍。真实插件不带 `x-pid`，要找出持有长连接的副本时用假平台的 `socketPeerPorts()` 加 `test/helpers/port-owner.ts`（按本地端口查进程）。
- 真实平台：`plugins/<name>/test/live/*.live.test.ts` 只在 `CAPYBARA_TEST_LIVE_TOOLS=1` 且平台变量齐全时运行（只跑不需要人操作的检查）；人工部分见 `docs/superpowers/plans/m4-live-acceptance-checklist.md`。

## 新渠道插件清单

1. 先写 README：建应用的步骤与权限（scope）表、每个取舍的平台文档出处与查阅日期、确认 / 重连 / 限流 / 长度 / 错误映射、待真实联调确认的事项。
2. 清单：`provides` 三种能力（按需）、`permissions.network`、`config.deployment`（登录）、`config.org`（通讯录，字段可选时实现 `configured`），渠道连接配置放 `connectionSchema`。
3. 按上面的约定实现，转义与链接白名单单独成文件并配单测。
4. 假服务端：平台协议能完整仿真就仿真（Lark 的 protobuf 帧），让插件测试跑真实 SDK。
5. 三处同一身份行的双副本用例。
6. `pnpm lint && pnpm typecheck && pnpm check && pnpm test`。
