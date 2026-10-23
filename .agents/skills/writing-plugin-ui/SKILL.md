---
name: writing-plugin-ui
description: 给插件加界面时使用（对话页右侧标签、顶栏「扩展」里的组织页面）：两档怎么选（渲染 schema 视图 / 嵌入应用 iframe）；清单 ui 贡献（place、kind、embed 的 path 在 /ui/ 下并声明为 GET）与 permissions.ui.views / embeds，view 不卡加载、embed 卡加载且是敏感项，perm-ui 检查；ctx.ui.view / action / invalidate（响应 signal、5 秒超时、错误码、网页刷新合并）；UiView 积木与 UI_LIMITS（text 在 M4 按纯文本显示、图片只认 http(s)、actionId 唯一、危险按钮、表格单元格用 Object.hasOwn）；工具结果的 ToolResult.display 双语摘要；嵌入令牌（300 秒、只认本插件、verifyEmbedToken 查启用状态、/api 不认）、/plugin-ui 代理（头白名单、private / no-store、只转发嵌入令牌、CSP sandbox）、消息桥（只在首次 load 发 init、load 前不导航、重挂上限、History API、navigate 规则）、静态页不含数据、SSE 按请求订阅 ctx.bus 与 req.signal；参考 plugins/todo、plugins/example-board，以及测试写法。
---

# 写插件界面

通用的插件写法（清单、权限批准、ctx、多副本禁令、双副本测试）见 `.agents/skills/writing-plugins`，工具本身见 `.agents/skills/writing-tools`；这里只讲界面。设计依据是 `docs/superpowers/specs/2026-10-21-chat-panel-plugin-ui-design.md`。参考实现：

- 第一档（渲染 schema 视图）：`plugins/todo`，对话视图 `tasks`，`todo__write` 写完调 `invalidate`。
- 第二档（嵌入应用）：`plugins/example-board`，组织页面 `board` 与对话标签 `board-conv`，带 SSE 实时刷新。

## 两档怎么选

| | 第一档：渲染 schema（`kind: "view"`） | 第二档：嵌入应用（`kind: "embed"`） |
|---|---|---|
| 插件给什么 | `render()` 返回一份 `UiView`（块列表），网页用设计系统组件画 | 插件路由提供的整页 HTML / JS，放进沙箱 iframe |
| 样式与代码 | 插件不能写样式、不能执行代码 | 页面自己负责，可以用外层发来的 `--cb-*` 设计 token |
| 交互 | 按钮、表单回调 `ctx.ui.action` | 任意（拖拽、多人协作、复杂表单） |
| 刷新 | `ctx.ui.invalidate` → 网页重取视图 | 插件自己开 SSE / 长轮询 |
| 批准 | 记入快照，**不卡加载** | **卡加载**、要批准、敏感项 |

**能用第一档就用第一档**：清单、进度、键值、表格、简单图表、几个按钮或一张表单都够了，而且没有新的安全面。只有积木画不出来的东西（看板拖拽、实时多人编辑、工作流画布）才上嵌入应用。

两档能放的位置一样：`place: "conversation"` 是对话页右侧面板的一个标签（面板里还有内核自带的「运行」「上下文」）；`place: "page"` 是顶栏「扩展」菜单里的组织页面，路由 `/p/<插件>/<id>`。贡献只在**启用了本插件的组织**出现；kind view 还要求插件真的用 `ctx.ui.view` 注册了 render。

**角色（Ruling A38）**：`place: "page"` 的贡献（view 与 embed）只给组织角色 **member 以上**。guest 的贡献列表里没有组织页面；guest 取组织页面视图、执行其动作、签组织页面的嵌入令牌、连组织级刷新流一律 404 `ui.not_found`（与不存在一样）。`place: "conversation"` 的贡献照常给能访问该对话的任何角色（guest 也用共享的 agent）。插件在 `UiRenderArgs` / `UiActionArgs` / `EmbedClaims` 里都能拿到 `role`（`owner` / `admin` / `member` / `guest`），可以据此再收紧（例如只有 member 以上能改数据）；但不需要自己挡 guest 进组织页面，内核已经挡了。

## 清单

```ts
definePlugin({
  name: "todo",
  ui: [{ id: "tasks", title: { zh: "任务", en: "Tasks" }, place: "conversation", kind: "view" }],
  permissions: { tools: ["write"], ui: { views: ["tasks"] } },
  // ...
});

definePlugin({
  name: "example-board",
  ui: [
    { id: "board", title: { zh: "看板", en: "Board" }, place: "page", kind: "embed", path: "/ui/board" },
    { id: "board-conv", title: { zh: "看板", en: "Board" }, place: "conversation", kind: "embed", path: "/ui/board-conv" },
  ],
  permissions: {
    http: [{ method: "GET", path: "/ui/board" }, { method: "GET", path: "/ui/board-conv" }, /* 数据路由也在 /ui/ 下 */],
    ui: { embeds: ["board", "board-conv"] },
  },
});
```

- 贡献 `id` 匹配 `^[a-z][a-z0-9-]{0,39}$`，插件内唯一；`title` 的 zh / en 都要非空、≤ 100 字符。
- `path` 只允许用在 embed 上：以 `/ui/` 开头，并且在 `permissions.http` 里声明为 `GET <path>`。embed 用到的所有路由（页面、脚本、数据、SSE）都要放在 `/ui/` 下，网页代理只转发到这里。
- **双向交叉核对**（`definePlugin` → `validateUiContributions`，内核加载时也走它）：kind view 的 id 必须列在 `permissions.ui.views`，kind embed 的列在 `permissions.ui.embeds`；反过来 `permissions.ui` 里的每个 id 也必须有同 kind 的贡献。同一个 id 不能两边都列。
- **批准**：权限键是 `ui.view:<id>` 与 `ui.embed:<id>`。
  - `ui.view:*` 记入快照、管理员审阅时看得到，但**从不卡加载**：插件升级只多出 view 时照常加载，内核把它补进快照（不写审计，记一条 info 日志 `plugin ui views merged into the permission snapshot`）；`capybara plugins approve` 对这种升级也回答「无需批准」。理由是视图只把插件已有的数据交给我们的组件画，没有新能力。例外：全新插件（还没有快照）即使只有 view 也要批准。
  - `ui.embed:*` 和其他新增权限一样卡加载、等 `capybara plugins approve`，并且是**敏感项**：`capybara plugins review` / `approve` 在它后面标 `  (sensitive)`，组织启用页的 `ui` 分组高亮。敏感判定只有一份（`permission-view.ts` 的 `isSensitivePermissionKey`）。
- **静态检查 `perm-ui`**（`pnpm check:plugin-permissions`）：`ctx.ui.view(id)` / `ctx.ui.action(id)` 的 id 必须在 `permissions.ui.views` 里（action 也按 views 检查，embed 不走 action）。id 写成字符串字面量或同文件 const；动态值、给 `ctx.ui` 起别名都报「Cannot statically confirm」，确属运行时才知道的用 `// capybara:allow-dynamic-permission <原因>` 豁免；明确的未声明不能豁免。把 `ctx.ui` 传给别的函数时传一个包装（todo 的 `{ invalidate: (t) => ctx.ui.invalidate(t) }`），检查才能看到用法。

## 第一档：`ctx.ui`

```ts
setup(ctx) {
  ctx.ui.view("tasks", async ({ orgId, accountId, conversationId, locale, signal }) =>
    tasksView(conversationId === undefined ? [] : await readTodos(ctx.db, conversationId)),
  );
  ctx.ui.action("tasks", async ({ actionId, payload, answer, signal }) => {
    // ...
    return { toast: { zh: "已清空", en: "Cleared" } }; // 或 { view: newView }，或 {}
  });
}
// 数据变了：
await ctx.ui.invalidate({ orgId, conversationId, contribution: "tasks" }).catch(() => {});
```

- `view` / `action` 只能在 `setup` 里调用（setup 结束即封存），id 必须在 `permissions.ui.views` 里，否则抛 `PluginPermissionError` 并写越权审计；同一个 id 重复注册抛错。
- 参数里的身份（`orgId`、`accountId`、`role`、`conversationId`）由内核鉴权后给出：对话视图已核对调用者能访问这个对话，插件拿不到用户的会话凭据。组织页面（place page）不传 `conversationId`。`locale` 是网页当前语言（`zh` / `en`，默认 `en`），视图里的文字按它出。
- **5 秒超时，`render` 与 `action` 都必须响应 `signal`**：把它传给查询和外部请求（`fetch(url, { signal })`），中止后尽快放弃。超时后用户看到的是失败、可能会重试，`action` 里的写操作尤其不能在超时后继续做完。
- 失败只影响那一个标签（显示错误和「重试」），对话照常流式显示；内核记告警，不写对话日志。错误码：

  | 码 | 状态 | 何时 |
  |---|---|---|
  | `ui.not_found` | 404 | 插件未启用 / 未加载、贡献不存在、把 embed 当视图取、视图没有 action、对话访问不了（别人的、不存在的、别的组织的、id 不是 UUID） |
  | `ui.render_failed` | 502 | `render` 抛错（不回显插件的异常信息） |
  | `ui.action_failed` | 502 | `action` 抛错 |
  | `ui.invalid_view` | 502 | 返回的视图或 toast 不合法 |
  | `ui.timeout` | 504 | 超过 5 秒（`signal` 已被中止） |
  | `validation_failed` | 400 | 对话视图缺 `conversationId`、组织页面带了它、动作请求体超限 |

- 动作请求体：`actionId` 1–200 字符；`payload` 按 JSON 的 UTF-8 字节数 ≤ `UI_LIMITS.payloadBytes`；表单 `answer` 的键数与多选长度 ≤ `UI_LIMITS.tableRows`，单个文本 ≤ `UI_LIMITS.textChars`。返回 `{ view }` 时网页直接替换视图（badge 一起更新），`{ toast }` 时弹出 `toast[locale]`。
- **`invalidate({ orgId, conversationId?, contribution })`**：`contribution` 是清单 `ui` 里的 id（view 或 embed 都行），`conversationId` 必须是会话 UUID。带对话就发到会话主题，对话 SSE 收到 `event: ui` `{"plugin","contribution"}`；不带就发到组织主题，组织级 SSE `GET /api/v1/orgs/:orgId/ui/stream` 收到。经 Redis bus 跨副本，不需要插件自己做什么。内核先用一条查询核对目标：本插件在 `orgId` 启用、带对话时对话属于 `orgId`；不满足就静默丢弃（只记 debug 日志，不抛错）。它只是「去重新取」的提示，鉴权在取视图时做；刷新失败不该影响业务写入，所以 `.catch(() => {})`。
- **网页的刷新合并**：每个视图同时至多一个请求在途，在途期间来的刷新不论几次，只在它完成后补取一次；重取期间保留旧视图，不闪回加载中；事件流断线重连后所有视图重取一次（断线期间可能漏帧）。所以 invalidate 可以放心地每次写入都调，不用自己节流。

## 第一档：`UiView` 的积木与上限

类型与 `validateUiView` 在 `packages/plugin-sdk/src/ui.ts`；内核对 `render` / `action` 的返回逐个校验，不合法按 `ui.invalid_view` 处理。

| 块 | 字段 | 网页怎么画 |
|---|---|---|
| `heading` | `text`（非空） | 小标题 |
| `text` | `markdown` | **M4 按纯文本加换行显示**（Ruling A36）：不渲染 Markdown，链接不可点，原生 HTML 当文字。字段名仍叫 `markdown`、校验仍要求链接是 http(s) 绝对地址（纵深防御），等以后有了 Markdown 组件再升级 |
| `checklist` | `items[{ text, status: pending / in_progress / completed }]` | 清单，`in_progress` 那项高亮，`completed` 划线 |
| `keyValue` | `items[{ label, value }]` | 键值表 |
| `table` | `columns[{ key, label }]`、`rows[Record<key, string>]` | 数据表。列 key 不能重复；行里不能有未声明的列，可以缺列 |
| `code` | `language?`、`text` | 等宽代码块 |
| `image` | `url`、`alt` | **只认 http(s) 绝对地址**（≤ 2000 字符，Ruling A34），插件自己路由下的相对地址会被拒 |
| `chart` | `kind: bar / line`、`series[{ label, value }]` | 柱状图 / 折线图；`value` 必须是有限数 |
| `actions` | `buttons[{ actionId, label, payload?, danger? }]`（非空） | 一组按钮，回调 `ctx.ui.action` |
| `form` | `form: InputForm`、`actionId`、`submitLabel` | 复用 `ask_user` 的表单字段，提交走 `action`（带 `answer`），必填项为空时不提交 |

视图可带 `badge`（≤ 32 字符），显示在标签上，如 todo 的「2/4」。

- **上限 `UI_LIMITS`**：`blocks` 50；`tableRows` 200（同时是 keyValue 项数、表格列数、图表点数、按钮数的上限）；`checklistItems` 100；`textChars` 20000（整个视图所有文字的总数，表单按 JSON 长度计入）；`payloadBytes` 2000（单个按钮 `payload` 的 JSON 字节数，不能序列化的也报错）。超了就整个视图不合法，自己截断并给出「还有 N 项」之类的文字。
- **`actionId` 在整个视图内唯一**（按钮和表单一起算），动作回调靠它区分来源。
- **危险按钮** `danger: true`：网页先弹 `DangerConfirm`，要用户输入按钮文字才执行。删除、清空、不可撤销的操作都要标。视图里的按钮一律不是主按钮（页面上唯一的主操作是「发送」）。
- **表格单元格用 `Object.hasOwn(row, key)` 判断**，不要 `row[key]` 或 `key in row`：列 key 可能是 `constructor`、`toString`，会取到原型链上的值。自己写渲染（如以后的 IM 卡片）时同样遵守。
- 视图里的文字是给人看的：按 `locale` 出中文或英文。它不进模型上下文。

## 工具结果的显示摘要 `ToolResult.display`

工具（插件工具与内置工具）可以在结果里给一句只给人看的说明，对话流里那一行工具调用就显示它，而不是原样的输入 JSON：

```ts
return {
  content: [{ type: "text", text: renderTodos(todos) }],
  display: { summary: { zh: `更新任务清单（${n} 项）`, en: `Updated task list (${n} items)` } },
};
```

- 中英文都要给、各 ≤ 200 码点（`validateToolDisplay`）；不合法的内核丢弃并记告警，结果照常写入。
- 摘要随 `tool_result` 事件进日志，刷新页面能还原；**不进模型上下文**，重建模型请求、生成压缩记录都不用它，所以模型需要的信息必须写在 `content` 里。
- 没有摘要（连接器工具的一律不采信）时，网页退回「工具名 + 输入的前两个字段」。细节见 `.agents/skills/writing-tools`。

## 第二档：嵌入应用

插件自己的页面放进网页的沙箱 iframe（`sandbox="allow-scripts allow-forms"`，不给 `allow-same-origin`，是不透明源），读不到外层页面和 Cookie。`apps/web` 只经设计系统的 `EmbedFrame` 渲染 iframe（`check:web-ui` 的 `web-ui-iframe` 规则）。

### 嵌入令牌

- 网页调 `POST /api/v1/orgs/:orgId/ui/embeds/:plugin/:id/token`（对话嵌入带 `{ conversationId }`）拿 `{ token, src, expiresAt, expiresIn }`；`src` 是 `/plugin-ui/<插件>/<path 去掉开头的 /ui/>`，如 `/plugin-ui/example-board/board`。签发时内核已核对插件已启用、贡献是 embed、调用者能访问这个对话。
- 令牌是 `base64url(声明).base64url(HMAC)`，**无状态**（不落库、不进 Redis），各副本用同一主密钥校验；有效期 300 秒（`EMBED_TOKEN_TTL_SECONDS`，容许 30 秒时钟偏差），主密钥轮换后上一把签的令牌在过期前仍有效。声明是 `EmbedClaims`：`plugin`、`orgId`、`accountId`、`role`、`conversationId?`、`contribution`、`exp`（`role` 签发时写入并在校验时核对是四种角色之一）。
- 插件**每个数据路由先 `await ctx.ui.verifyEmbedToken(token)`**，返回 null 就 401。它只认签给**本插件**的令牌（签给别的插件的一律 null），并且每次用一条 PG 查询确认本插件此刻仍在 `claims.orgId` 启用、组织未删除、账号 active 且仍是该组织成员（Ruling A37，不缓存）：组织停用插件、成员离职或账号停用后，已签出的令牌立即失效，重新启用后未过期的又能用。返回的 `role` 是校验时刻的角色；组织页面的令牌在调用者被降为 guest 后也返回 null。组织、账号、对话只从返回的声明里取，不信请求里的任何参数。对话令牌要按 `conversationId` 限定数据范围；组织令牌（没有对话）别让它看到对话里的数据（example-board 的 `scoped()`）。
- **内核 `/api` 不认嵌入令牌**：鉴权守卫只把 Bearer 当 API 令牌（`cap_pat_` / `cap_svc_`）查，嵌入令牌一律 401 `auth.required`。令牌泄露的最坏结果是在 300 秒内以该用户身份调用**这个插件**的数据路由。

### `/plugin-ui` 同源代理

网页的 `/plugin-ui/<插件>/<rest>` 转发到内核 `/plugins/<插件>/ui/<rest>`（`apps/web/src/lib/plugin-ui-proxy.ts`）：

- 只放行 GET / POST（OPTIONS 回 204 预检）；插件名、路径段不合规（空段、`.` / `..`、解码后含 `/`、`\` 或控制字符）直接 404，不转发。未声明的路由由内核返回 404。
- **请求头白名单**：`accept`、`accept-language`、`cache-control`、`content-type`、`if-modified-since`、`if-none-match`、`last-event-id`，加上可信的 `x-forwarded-for`。Cookie、CSRF 头都不转发。**`Authorization` 只转发嵌入令牌形状的 Bearer**（`Bearer <base64url>.<base64url>`、不以 `cap_` 开头），API 令牌和 Basic 都到不了插件。
- **响应头白名单**：`content-type`、`cache-control`、`etag`、`last-modified`、`expires`、`vary`、`content-language`、`x-accel-buffering`、`retry-after`；`Set-Cookie`、`Clear-Site-Data`、HSTS、NEL、`Link` 等其他头都丢掉。3xx 的 `Location` 只保留仍在 `/plugin-ui/<本插件>/` 下、规范化后不变的。
- **缓存只能是私有的**：这次请求转发了令牌就一律 `no-store`；没带令牌时插件给的 Cache-Control 去掉 `public` / `s-maxage` / `proxy-revalidate`、前面加 `private`；没给就 `no-store`。
- 每个响应统一加安全头：CSP（`default-src 'self'`、脚本与样式允许 `'unsafe-inline'`、`connect-src 'self'`、`frame-ancestors 'self'`、`base-uri 'none'`、`object-src` / `frame-src` / `worker-src 'none'`，以及关键的 **`sandbox allow-scripts allow-forms`**——页面被直接在顶层打开也是不透明源，不能带着用户 Cookie 同源调 `/api`）、`nosniff`、`Referrer-Policy: no-referrer`、`Access-Control-Allow-Origin: *`（不带 `Allow-Credentials`）。
- 请求体上限同 `/api`（超了 413），上游不可达 502，响应体流式透传（SSE 可用）。
- 所以页面里一律用**相对地址**（`fetch("cards")`、`<script src="board.js">`），外部资源会被 CSP 拦下。

### 消息桥（`postMessage`，协议 `capybara-embed/1`）

- **外层 → iframe**：
  - `init`（令牌、`locale`、`theme`、`--cb-*` 设计 token（最多 300 个，单值 ≤ 200 字符）、`context: { orgId, conversationId? }`）**只在 iframe 第一次 `load` 时发**；令牌晚到就等令牌到了再发。
  - `token`：续期，取到令牌后按 `max(30 秒, expiresIn − 60 秒)` 安排（不比浏览器时钟），失败 10 秒后重试，标签里显示一行警告。
  - `theme`：外层主题切换时发。
- **iframe 再次 `load` 就视为离开了插件页面**（整页导航、表单提交跳转、给 `location` 赋值）：外层不再给它发任何消息、不再处理它的消息，并在原 `src` 上重新挂载 iframe；10 秒内最多重挂 3 次，再多就停下来显示错误，等用户点「重试」。所以：
  - **多页面用 History API**（`history.pushState` 加前端路由），不要整页跳转。
  - **页面在 `load` 之前不得导航**：外层只看得到 `load` 事件、看不到是哪个文档，`init`（含令牌）会交给第一个触发 `load` 的文档。不要在加载过程中重定向、`location.replace` 或 `<meta http-equiv="refresh">`；路由层面的重定向只能留在本插件的 `/plugin-ui/<插件>/` 下。
- **iframe → 外层**，用 `window.parent.postMessage(msg, "*")`（不透明源没法指定 targetOrigin），外层先核对来源是这个 iframe，再用 `parseEmbedChildMessage` 校验，不认识的忽略：
  - `resize { height }`：0–10000，外层夹在 120–4000 像素之间。
  - `navigate { path }`：只能是站内路径（如 `/chat/<id>`）：单个 `/` 开头，任何位置没有 `//`、反斜杠和控制字符；路径部分没有 `.` / `..` 段（含 `%2e` 编码）、没有 `%2f` / `%5c` / `%00`–`%1f` / `%7f`；按 URL 规范化后与原文相同；≤ 2000 字符。非 ASCII 字符先 `encodeURIComponent`。SDK 与网页的校验逐字相同，共享测试向量 `tools/fixtures/embed-navigate-vectors.json`。
  - `toast { text }`：非空、≤ 500 字符，按纯文本显示。
- 外层的实现在 `apps/web/src/lib/embed-bridge.ts` 与 `components/chat-panel/EmbedTab.tsx`，插件不用管，只要守上面的规则。

### 页面与数据

- **静态页面与脚本不含数据**，可以不验令牌（iframe 用 `src` 导航时带不了 `Authorization` 头，令牌是 `init` 才给的）；数据只经验令牌的路由给。不要把令牌放进 URL 查询串（会进日志和浏览器历史）。
- DOM 用 `textContent` 构建，数据不经 `innerHTML`。样式用 `var(--cb-*, 兜底值)`，在 `init` / `theme` 时写到 `:root`。
- **实时刷新走 `ctx.bus`，按请求订阅**：SSE 路由里 `await ctx.bus.subscribe(topic, ...)`，在 `req.signal` 中止（客户端断开）或 `ReadableStream` 的 `cancel` 里退订；到令牌 `exp` 时主动结束流，页面用续期后的令牌重连，权限随令牌过期。心跳用 `AbortSignal.timeout` 做本次请求内的等待，不用定时器；不放模块级的订阅表。页面读流用 `fetch`（`EventSource` 带不了 `Authorization` 头）。写入方 `ctx.bus.publish` 一次，其他副本上的流都能收到。
- `req.signal` 只在响应写完之前客户端断开时中止，正常写完不会中止。

## 测试写法

- **纯函数**：视图函数单测（todo 的 `tasksView`）并用 `validateUiView` 断言为空；工具 handler 注入假的 `ui`（`{ invalidate: async (t) => void calls.push(t) }`）断言调用参数；见 `plugins/todo/test/todo.test.ts`。
- **内核接口（单副本 `createKernel`）**：`packages/kernel/test/ui/views.http.test.ts`（成功、502、504、非法视图、他人对话 404、未启用 404、服务令牌 403）与 `embed.http.test.ts`（签发 401 / 403 / 404 / 400、令牌调 `/api` 401、别的插件的令牌 401、跨组织 / 跨对话隔离、停用后 401）。测试插件 `test/fixtures/plugins/ui-probe` 覆盖各种失败，路由 `POST /invalidate` 可以从指定副本触发刷新。
- **权限**：`packages/kernel/test/ui/permissions.test.ts`（`planApprovals`、host 升级多 view / 多 embed，fixture `ui-a` → `ui-a-view` → `ui-a-embed`）；CLI 的 `(sensitive)` 标记见 `apps/capybara/test/plugins.test.ts`。
- **双副本**：`packages/kernel/test/ui/ui-stream.dual.test.ts`、`embed.dual.test.ts` 与验收 `m4-segment3.dual.test.ts`。SSE 用 `test/helpers/sse.ts` 的 `openSse(url, headers)` 直连某个副本端口（`replicaOf(res)` 确认落点），`until(pred)` 等帧，`uiFrames(messages)` 取 `event: ui` 的数据。跨副本刷新的断言要在**两个**副本上都开流（工具在哪个副本执行不确定）；退订用 Redis `PUBSUB CHANNELS` 断言没有残留订阅。
- **网页**：`apps/web/test/chat-panel.test.tsx`（标签、失败重试、嵌入标签的 sandbox / init / 忽略别的 window）、`embed-bridge.test.tsx`、`plugin-ui-proxy.test.ts`；端到端 `e2e/embed-board.spec.ts`。
