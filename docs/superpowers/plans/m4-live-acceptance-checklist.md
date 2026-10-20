# M4 真实平台验收清单（Slack / Lark）

M4 第二段验收（Task 20）分三部分：

1. **双副本假平台验收**（自动，`pnpm test` 里跑）：`packages/kernel/test/channels/m4-segment2-slack.dual.test.ts`、
   `m4-segment2-lark.dual.test.ts`。
2. **真实平台自动检查**（不需要人操作，有凭据时跑）：`plugins/slack/test/live/slack.live.test.ts`、
   `plugins/lark/test/live/lark.live.test.ts`。
3. **真实平台人工检查**（本清单第 3–5 节）：私聊机器人、点卡片、浏览器登录、通讯录变动事件。

平台侧建应用的每一步与权限（scope）表见 `plugins/slack/README.md`、`plugins/lark/README.md`，这里不重复。

---

## 1. 凭据与环境变量

凭据放在 `~/.capybara-test.env`，由外层 shell 注入环境（测试代码不读这个文件），**任何时候都不要打印或贴出值**。
值以「替换为」开头视为未填。

| 变量 | 必填 | 说明 |
|---|---|---|
| `CAPYBARA_TEST_LIVE_TOOLS` | 是 | 设为 `1` 才跑真实平台用例 |
| `CAPYBARA_TEST_SLACK_APP_TOKEN` | Slack 必填 | 应用级令牌 `xapp-…`（scope `connections:write`） |
| `CAPYBARA_TEST_SLACK_BOT_TOKEN` | Slack 必填 | 机器人令牌 `xoxb-…`（manifest 里的 bot scope 全部授予，含 `users:read`、`users:read.email`） |
| `CAPYBARA_TEST_SLACK_TEAM_ID` | Slack 必填 | 工作区 id `T…` |
| `CAPYBARA_TEST_SLACK_CHANNEL` | 可选 | 测试频道 id（`C…`，机器人须已加入）或与机器人的私聊 id（`D…`）；填了才跑收发 / 卡片用例 |
| `CAPYBARA_TEST_SLACK_CLIENT_ID` / `_CLIENT_SECRET` | 可选 | Sign in with Slack 的 Client ID / Secret；填了才跑登录检查 |
| `CAPYBARA_TEST_LARK_APP_ID` | Lark 必填 | 企业自建应用 App ID `cli_…`（登录、机器人、通讯录同一个应用） |
| `CAPYBARA_TEST_LARK_APP_SECRET` | Lark 必填 | 该应用的 App Secret |
| `CAPYBARA_TEST_LARK_CHAT_ID` | 可选 | 测试群（或与机器人的单聊）的 `oc_…`，机器人须在其中；填了才跑收发 / 卡片用例 |
| `CAPYBARA_TEST_LARK_CHAT_TYPE` | 可选 | 上面是单聊时设为 `dm`（默认按群聊渲染） |

## 2. 真实平台自动检查

```bash
set -a; . ~/.capybara-test.env; set +a     # 只注入环境，不要 cat / echo
CAPYBARA_TEST_LIVE_TOOLS=1 pnpm vitest run plugins/slack/test/live -t live
CAPYBARA_TEST_LIVE_TOOLS=1 pnpm vitest run plugins/lark/test/live -t live
```

预期（每项都应通过；缺可选变量的用例显示 skipped）：

| 用例 | Slack 预期 | Lark 预期 |
|---|---|---|
| verify | `tenantId` = `TEAM_ID`，`botUserId` 为 `U…` / `W…` | `botUserId` 为 `ou_…`，`tenantId`（tenant_key）非空 |
| 长连接 | `apps.connections.open` 返回 `wss://…`；插件 `connect` 连上后 10 秒内不抛错、没有 warn / error 日志、没有重连，中止后正常返回 | 同左（SDK `WSClient`） |
| 通讯录第一页 | 至少一人，租户 = `TEAM_ID`，id 为 `U…` / `W…`，邮箱一律未验证 | 至少一人，租户与 verify 一致，id 为 `ou_…`（需通讯录权限范围为全部成员） |
| 收发与卡片 | 测试频道里出现一条消息 → 被编辑（「edited」加粗）→ 一张审批卡片 → 卡片变为「已批准」、按钮消失 | 测试群里出现一张消息卡片 → 被更新 → 一张审批卡片（中文）→ 变为「已批准」、按钮消失 |
| 登录 | 授权地址为 `https://slack.com/openid/connect/authorize`、scope `openid email profile`；用无效授权码换 token 得到 `invalid_code`（不是 `invalid_client_id` / `bad_client_secret`，即客户端凭据正确） | 授权地址为 `https://accounts.larksuite.com/open-apis/authen/v1/authorize`，带 PKCE |

收发用例跑完后**到 IM 里目视确认**：消息格式（Slack mrkdwn 加粗、Lark 卡片 markdown）、审批卡片的标题 / 工具名 /
参数预览 / 两个按钮的排布，更新后按钮确实消失。

失败时常见原因：Socket Mode 未开启或 app token 缺 `connections:write`（Slack）；长连接订阅方式没选「使用长连接」
或版本未发布（Lark）；机器人不在测试频道 / 群里（`not_in_channel` / 230002）；通讯录权限范围不是全部成员（Lark 40004）。

## 3. 人工检查的准备：本地起一套内核 + 网页

```bash
docker compose -f docker/compose.dev.yaml up -d
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake","@capybara-hq/plugin-todo","@capybara-hq/plugin-slack","@capybara-hq/plugin-lark"]'
export CAPYBARA_PLUGIN_PERMISSIONS__AUTO_APPROVE=true        # 只用于本地试用
export CAPYBARA_HTTP__TRUST_PROXY=1
export CAPYBARA_AUTH__COOKIE_SECURE=false                    # 公网地址是 https 隧道时去掉这一行
export CAPYBARA_HTTP__PUBLIC_URL=<网页的外部可达地址>          # 如 http://localhost:3000，或隧道给的 https 地址
export CAPYBARA_AUTH__LOGIN_SOURCES='["slack","lark"]'
# 部署级登录配置（值从环境变量引用，不要写进命令历史里的明文）
export CAPYBARA_PLUGIN_CONFIG="{\"slack\":{\"clientId\":\"$CAPYBARA_TEST_SLACK_CLIENT_ID\",\"clientSecret\":\"$CAPYBARA_TEST_SLACK_CLIENT_SECRET\"},\"lark\":{\"appId\":\"$CAPYBARA_TEST_LARK_APP_ID\",\"appSecret\":\"$CAPYBARA_TEST_LARK_APP_SECRET\"}}"
pnpm capybara migrate
pnpm capybara start            # 内核 :8080
pnpm dev:web                   # 另一个终端，网页 :3000
```

- 平台要求登录回调是 https 时，用隧道（如 `cloudflared tunnel --url http://localhost:3000`）把 :3000 暴露成 https，
  并把 `CAPYBARA_HTTP__PUBLIC_URL` 设为它。
- 在 Slack 应用 **OAuth & Permissions → Redirect URLs**、Lark 应用 **安全设置 → 重定向 URL** 分别登记
  `<publicUrl>/api/v1/auth/sso/slack/callback`、`<publicUrl>/api/v1/auth/sso/lark/callback`。
- 浏览器打开 `<publicUrl>`：初始化向导建管理员 `owner` 与组织；「设置 → 组织 → IM 语言」选 **en**（下文的预期文案
  按英文写）。
- 新建 agent：模型 `model-fake/fake-1`，工具加 todo 插件的 `write`，并把它收紧为需要审批。网页暂不支持收紧时用 API
  建，定义为：

  ```json
  {
    "name": "Helper",
    "instructions": "Be helpful.",
    "model": { "provider": "model-fake", "model": "fake-1" },
    "tools": [{ "kind": "plugin", "plugin": "todo", "name": "write" }],
    "toolPolicies": { "todo__write": "ask" }
  }
  ```

  model-fake 的指令：`echo:<文本>` 原样回复；`slow:<毫秒>:<文本>` 逐块慢速流出；
  `tool:todo__write:{"todos":[{"content":"Ship M4","status":"pending","activeForm":"Shipping M4"}]}` 调用写工具。
- 准备三个 IM 测试账号：**A**（发起人，同时有本地账号 `alice`，由 owner 邀请加入组织）、**B**（另一位组织成员，
  由通讯录同步加入）、**C**（用来测登录与离职）。

下面 Slack、Lark 各做一遍；「平台差异」列只写不同之处。

## 4. 人工检查步骤

### 4.1 建连接（只一条长连接）

| 步骤 | 预期 |
|---|---|
| 「设置 → 插件」启用 `slack`（`lark`），组织级配置填通讯录凭据（Slack `teamId` + `botToken`；Lark `appId` + `appSecret`）→「立即同步」 | 审计里出现 `org.directory.synced`（`partial: false`）；B、C 成为成员（来源 `directory:slack` / `directory:lark`）；A 若也在通讯录里，会被同步成**另一个**账号——先确保 A 的 IM 账号不在通讯录范围内（Slack：首轮同步后再把 A 拉进工作区；Lark：A 不在通讯录可见范围），或先完成 4.2 再同步 |
| 「渠道 → 新建连接」，选插件、填 bot 凭据、选 Helper、未绑定处理选 `bind` | 保存成功；连接页显示租户（Slack `T…`、Lark tenant_key）、机器人、状态「已连接」，`last_error` 为空；凭据只显示「已设置」 |

### 4.2 绑定（未绑定的人私聊）

| 步骤 | 预期 |
|---|---|
| A 私聊机器人发 `hello` | 收到 **Please link your Capybara account before chatting with me.** 与一个打开网页的按钮（Slack Block Kit 链接按钮 / Lark 卡片按钮） |
| 不认识的人在群里 @ 机器人 | 只收到一句提示去私聊（含 `direct message`），群里**没有**绑定链接 |
| A 点按钮，浏览器里以 `alice` 登录 | 确认页显示 A 的平台显示名（防钓鱼）与连接名；点确认后提示绑定成功 |
| 再次打开同一个绑定链接 | 链接已失效（单次有效） |
| 「设置 → IM 身份」 | 出现 `slack:<T…>` / `lark:<tenant_key>` 的一行身份 |

### 4.3 私聊流式回复

| 步骤 | 预期 |
|---|---|
| A 私聊发 `slow:150:` 加一段约 200 字的英文 | 先出现一条草稿，随后被**原地**多次更新、最后定稿为完整文本；全程只有**一条**机器人消息（Lark 为一张卡片，Slack 为一条普通消息） |
| 网页「对话」里打开这段对话 | 能看到同样的内容；对话属于 `alice`、agent 为 Helper |

### 4.4 群聊审批卡片

| 步骤 | 预期 |
|---|---|
| 把机器人拉进测试群，A 在群里 @ 机器人并发 `tool:todo__write:{…}`（见第 3 节） | 机器人在**以这条消息为根的话题**里回一张审批卡片：工具名 `write`、参数预览、按钮 **Approve once**（及会话内批准 / 拒绝）、到网页处理的链接 |
| B 点 **Approve once** | 话题里收到 **You can't handle this request.**；卡片不变；网页上该审批仍是待处理；工具没有执行 |
| A 点 **Approve once** | 卡片原地变为「Approved」、按钮消失；话题里随后出现最终回复（含 todo 列表的结果）；网页上审批为已批准、决定人 alice |
| A 快速连点两次（新开一个审批） | 只批准一次；第二次点击得到「已处理」类提示或无变化，不会执行两次 |

平台差异：Lark 的卡片回调走长连接，**尚待确认**点击在内核短暂不可用时是否被重推（停掉内核 → 点按钮 → 立即重启，
观察 30 秒内卡片是否被处理；不被处理则记下来，需再点一次）。

### 4.5 杀副本接管（可选，需起两个内核副本）

| 步骤 | 预期 |
|---|---|
| 再起一个内核副本（同一 PG / Redis，另一个端口，如 `CAPYBARA_HTTP__PORT=8081 pnpm capybara start`） | 平台侧仍只有一条长连接（连接页状态不变） |
| `kill -9` 持有长连接的那个副本（看哪个副本日志里出现连接建立；或依次试） | 约一个租约周期（默认 30 秒）内另一副本接管，连接页仍为「已连接」 |
| 接管后 A 私聊 `echo:after takeover` | 只收到一条回复 `after takeover`；之前的消息没有被重复回复 |

### 4.6 网页登录

| 步骤 | 预期 |
|---|---|
| 退出网页登录，在登录页点「使用 Slack / Lark 登录」，以 **A** 授权 | 回到登录页并提示该身份未验证（`sso.identity_not_verified`）：经 IM 绑定的身份不能直接登录（Ruling A18） |
| 以 `alice` 登录网页，「设置 → IM 身份」对该身份点「验证」，走一次平台授权 | 回到网页，仍是 `alice`；之后退出，再用平台登录以 A 授权 → 直接进入 `alice` 账号 |
| 退出，用平台登录以 **C** 授权 | 进入 C 的账号（4.1 通讯录同步已建的同一个账号，没有新建第二个；「设置 → IM 身份」只有一行）；Slack 登录时浏览器的地址是 `slack.com/openid/connect/authorize`，Lark 是 `accounts.larksuite.com/...` 并带 `code_challenge` |
| 在平台授权页点「取消 / 拒绝」 | 回到登录页并显示登录失败，不会建账号 |

### 4.7 通讯录变动事件（加入与离职）

| 步骤 | 预期 |
|---|---|
| 平台上新增一个成员 D（Slack：邀请进工作区，触发 `team_join`；Lark：通讯录里新建用户并激活，触发 `contact.user.created_v3`） | 1 分钟内审计出现一次 `org.directory.synced`，触发来源 `changed`、`added: 1`；D 成为组织成员（来源 `directory:*`） |
| 修改 D 的姓名（`user_change` / `contact.user.updated_v3`） | 又触发一次同步（`changed`），`added: 0`、`removed: 0` |
| 停用 D（Slack：Deactivate account；Lark：设为离职） | 下一轮同步（变动事件触发，或「立即同步」）里 `removed: 1`；审计 `org.member.offboarded`（`reason: directory`）；D 的网页会话被吊销（刷新页面回到登录页） |
| D（若还能发消息）或停用前再私聊机器人 | 停用后机器人回复他不是组织成员（含 `not a member`），不会以他的身份运行 agent |
| 手动「移出」一个由通讯录加入的成员 E，再「立即同步」 | E 不会被加回（排除名单，Ruling A20） |

### 4.8 收尾

- 全程查看内核日志：没有打印任何令牌 / App Secret（只出现「已设置」或打码）。
- 连接页 `last_error` 为空；平台侧（Slack 应用的 Socket Mode 页面 / Lark 开发者后台的长连接状态）只有一条连接。
- 停用连接：连接页「停用」后平台侧连接很快断开（不超过一个扫描周期）；机器人不再回复。

## 5. 记录结果

把每一步的结果（通过 / 不通过 + 现象）记到 Task 20 的报告或 PR 描述里，尤其是 README 里「尚待真实平台联调确认」的几项：

- Lark 卡片回调回失败后是否重推；
- Lark JSON 2.0 卡片（多选表单、按钮布局）的实际渲染；
- Lark 长连接的 WSS 主机名（用于 `permissions.network` 是否需要补列）；
- Lark v2 token 接口的返回码类型、部门递归分页的稳定性；
- Slack Socket Mode 在真实工作区的重连（Slack 约每几小时回收一次连接，长时间开着观察 `refresh_requested` 后立即重连）
  与限流表现。
