---
name: writing-tools
description: 给 agent 新增或修改工具时使用：插件用 ctx.tools.register 注册工具（参考 plugins/todo）、内核内置工具、连接器工具的共性规则。工具命名与 key、英文描述与可执行的错误文案（pnpm check 的工具设计规则）、注解与默认策略、defaultPolicy 与 policy_source、ToolError 与 kind（unavailable 计入熔断）、超时与中止、输出大小与存档（限本会话，read_tool_output、{"$output": id}）、InputRequired 与续跑、tool_search（目录、已加载集合、描述可被搜索）、工具定义漂移与复核、插件须在组织启用；内置的沙箱工具 sandbox_*（按工具的超时与转存阈值、sandboxToolPolicy、首次使用 / 重建提示）与技能工具 skill_load / skill_write（目录快照、R3 对共享 agent 固定 ask、私有 agent 的 writePolicy 开关、变更审批）。写连接器见 writing-connectors。
---

# 写工具

通用的插件写法（清单、配置、ctx、多副本禁令、双副本测试）见 `skills/writing-plugins`，这里只讲工具特有的部分。参考实现：

- 插件工具：`plugins/todo`（一个 `write` 工具，整表写入本插件 schema，默认 allow）。
- 连接器：`plugins/connector-mcp`（`connector@1`，把远端 MCP 服务接成连接器）；`plugins/connector-openapi`（OpenAPI 3.0 / 3.1 描述的 HTTP API，每个 operation 一个工具，实现了 `inspect`）。
- 内核内置工具：`packages/kernel/src/tools/builtins`（`ask_user`、`read_tool_output`、`tool_search`；沙箱工具 `sandbox_*`
  在 `builtins/sandbox/`；技能工具 `skill_load` / `skill_write`）。见下文「内核内置工具：沙箱与技能」。

工具的执行全部经内核管线 `packages/kernel/src/tools/pipeline.ts`：解析 `{"$output": id}` 引用 → ajv 校验参数 → 策略判定（allow / ask / deny）→ 写 `tool_call_started` → 执行（超时 + 中止）→ 渲染结果 → 超大结果转存 → 写 `tool_result`。插件只管「做事并返回结果」，审批、超时、存档、审计、打码都是内核的事，**不要在插件里重复实现**。

## 三种工具来源与 key

模型看到的工具名（key）必须匹配 `^[a-zA-Z0-9_-]{1,64}$`：

| 来源 | key | 名字规则 |
|---|---|---|
| 内置 | 名字本身：`ask_user`、`read_tool_output`、`tool_search`、`sandbox_bash`、`skill_load` | 小写 + 下划线，**不含点**（Ruling M12） |
| 插件 | `<plugin>__<tool>`，如 `todo__write` | `spec.name` 匹配 `^[a-zA-Z0-9_-]{1,40}$`（`PLUGIN_TOOL_NAME`） |
| 连接器 | `<connectorSlug>__<tool>`，如 `docs__search` | slug `^[a-z][a-z0-9_]{0,23}$`，不含连续 / 结尾下划线；工具名由远端决定 |

key 超长或含非法字符时**不截断、不猜**：保存 agent 时报 `validation_failed`；连接器工具在安装 / 刷新时停用并在 `issues` 里写原因。名字用小写 + 下划线的动词短语（`write`、`search`、`delete_doc`），不要把插件名再写进工具名（key 已带前缀）。

agent 定义按引用选工具：`{kind:"builtin",name}`、`{kind:"plugin",plugin,name}`、`{kind:"connector",connectorId,tools:"all"|string[]}`。运行时每步实时解析（`ToolRegistry.forAgent`），不可用的工具（插件未启用、连接器停用 / 删除、工具待复核等）跳过并写一条英文 `reminder`（`The following tools are unavailable in this run: <key> (<reason>), …`），模型仍调用它时得到 `Tool "<key>" is unavailable: <reason>.`，整轮不失败。

## 插件工具：`ctx.tools.register`

```ts
import { definePlugin, ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";

const SPEC: ToolSpec = {
  name: "write",
  description:
    "Create and update the task list for the current conversation. Use it for work with three or " +
    "more steps … Do not use it for a single trivial task.",
  inputSchema: { type: "object", properties: { /* … */ }, required: ["todos"], additionalProperties: false },
  defaultPolicy: "allow",
};

export default definePlugin({
  name: "todo",
  // …
  setup(ctx) {
    ctx.tools.register(SPEC, async (input, call) => {
      // call: { orgId, accountId, agentId, conversationId, callId, signal, resume? }
      // …校验、写 ctx.db…
      return { content: [{ type: "text", text: "Todo list updated (3 items): …" }] };
    });
  },
});
```

- **只能在 `setup` 期间注册**，之后调用抛错；同一插件内名字不可重复；`validateToolSpec` 在注册时校验（名字、非空描述、inputSchema 为对象、`defaultPolicy` 只能 `allow` / `ask`）。
- **插件工具只在启用了该插件的组织可用**（Ruling A5，与模型供应商不同）：组织 admin 需 `PUT /api/v1/orgs/:orgId/plugins/<plugin> {"enabled": true}`。未启用时 agent 仍可保存引用（只校验插件已注册），运行时按「不可用」处理（见上）。连接器是部署级的，不需要按组织启用。
- 处理函数里的状态遵守多副本纪律：持久数据进 `ctx.db`（todo 按 `conversationId` 一行 upsert），不放模块级 Map。
- 处理函数**必须响应 `call.signal`**（超时 `tools.timeoutMs` 与 run 中止合并后的信号）：把它传给 `fetch` / 数据库查询等。内核与处理函数竞速，不响应也会按时返回超时结果，但你的副作用可能还在跑。
- 参数在调用前已按 `inputSchema` 用 ajv（2020-12）校验过；不合法时模型拿到全部错误路径 + 完整 inputSchema，处理函数不会被调用。处理函数里再用 zod 解析一次拿类型，解析失败抛 `ToolError`（见下）。

## 描述与错误文案（模型可见，一律英文）

`pnpm check`（`check:tool-design`，`tools/checks/src/tool-design.ts`）静态检查：

| 规则 id | 要求 |
|---|---|
| `tool-description` | `ctx.tools.register(spec, …)` 与内置 `BuiltinTool` 字面量的 `spec.description` 是字符串字面量（可 `+` 拼接、可引用本文件内的 const），≥ 20 字符，不含中文 |
| `tool-error-actionable` | `new ToolError(msg)` 的 msg 是字面量 / 模板（或本文件内的常量、函数返回值），且含建议动词 `use` / `call` / `retry` / `check` / `ask` / `pass` / `provide` 之一 |

检查之外的写法要求：

- **描述说清三件事**：做什么、什么时候用、什么时候不该用；有副作用的说明副作用（如「Each call replaces the whole list」）。inputSchema 每个字段写 `description`，给例子。
- **错误给事实与下一步**：说清哪里错了、模型下一步该做什么（换参数重试、先调用别的工具、请用户处理）。例：`Invalid todos: pass an array of items with content, status and activeForm, where status is pending, in_progress or completed.`；`Authentication failed for this app; ask the user to reconnect it.`
- 不在错误里回显凭据、内部路径或堆栈；不做模糊匹配（「你是不是想调用 X」）。
- 界面上显示的文案（表单标题、字段标签）可给 `{ zh, en }` 双语，走 i18n；给模型的只用英文。

## 注解与默认策略

`ToolSpec.annotations`（与 MCP 对齐）：`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`、`requiresUserInteraction`。

- 默认策略：插件 / 内置工具声明了 `defaultPolicy` 就用它；否则按注解推导 —— `readOnlyHint: true` → `allow`，其余（含无注解、destructive）→ `ask`（`policyFromAnnotations`）。连接器工具在安装时按注解推导并存进 `connector_tools.default_policy`，管理员可改。
- 只有确实无副作用、或副作用只落在本会话的工具才声明 `defaultPolicy: "allow"`（如 todo）；拿不准就别声明，让它走 `ask`。
- 最终策略在**执行那一刻**取最严者：组织默认策略、agent 的 `toolPolicies`（只能收紧为 `ask` / `deny`）、`requiresUserInteraction` 与 R3 清单（至少 `ask`，记住的授权对它们无效；`skill_write` 对共享 agent 固定 ask，对私有 agent 仅在 `skills.writePolicy = "ask"` 时固定 ask，见下文）；用户记住的授权（本会话 / 以后都允许）只能把 `ask` 放行为 `allow`，`spec_hash` 变了即失效，不越过 `deny`。
- `ask` → 内核建审批、run 进入 `waiting`（不占会话锁与配额），批准后从 checkpoint 续跑；拒绝 / 超时（`tools.approvalTimeoutHours`）/ 等待中被中止一律按拒绝写 `tool_result`。插件无需关心。

## 结果、`ToolError` 与失败

- 返回 `{ content: ToolContent[], isError? }`。`text` 原样拼接；`image` / `resource_link` 给模型的是类型说明（不丢弃）。`isError: true` 表示「工具执行了但结果是错误」，内容照样给模型。
- 抛 `ToolError(message)`：message **原样**给模型（所以必须英文、可执行）。可选第二个参数 `{ kind: "unavailable" }` 表示远端不可用（连不上、HTTP 5xx），只对连接器有意义；缺省 `kind: "error"`（参数错误、业务错误、鉴权失败等）说明远端可达。熔断语义（Ruling A15）：连接器级熔断只统计「远端不可用」——超时、传输 / 连接错误（非 `ToolError` 的异常）、`kind: "unavailable"`；`kind: "error"` 的 `ToolError` 与 `isError` 结果都表示远端可达，清零计数。插件工具与内置工具不受熔断影响。
- **显示摘要 `display`（可选，只给人看）**：`{ content, display: { summary: { zh, en } } }`，对话流里那一行工具调用显示这句话（如 todo 的「更新任务清单（3 项）」/「Updated task list (3 items)」），不再显示原样的输入 JSON。中英文都要给、各 ≤ 200 码点（`validateToolDisplay`）；不合法的内核丢弃并记告警，结果照常写入。摘要随 `tool_result` 事件进日志（刷新页面能还原），**不进模型上下文**（重建请求只用 content / isError），所以别把模型需要的信息只写在摘要里。只认插件工具、内核内置工具与内核的 resources 工具给的摘要；连接器工具的结果不采信（网页退回「工具名 + 输入的前几个字段」）。内置工具 `ask_user` / `read_tool_output` / `tool_search` 都给了摘要。
- 抛其他错误：模型只看到 `Tool <key> failed (<ErrorName>). The operation may not have completed; check before retrying or try another approach.`，错误详情进日志（经打码）。不要依赖异常消息传话。
- 超时：`Tool <key> timed out after <n>s. The operation may or may not have completed; verify before retrying.`
- **有副作用不盲目重跑**（spec 4.3）：内核在执行前写 `tool_call_started`。进程在执行中崩溃，续跑时这次调用的结果写为 `Result unknown: the call was interrupted before a result was recorded. Verify the outcome before retrying.`，**不会再调用你的处理函数**。所以处理函数无需为「被内核重放」做幂等，但模型可能看到「结果未知」后自己重试 —— 有条件的话让写操作天然幂等（如 todo 的整表覆盖）。

## 输出大小与存档

- 渲染后的结果超过 `tools.outputSpillChars`（默认 50000 字符）时，全文存进输出存档（`tool_outputs`，保留 `tools.outputRetentionDays` 天），模型只见前 `tools.outputPreviewChars`（默认 2000）字符与说明：`[Output truncated: … Full output id: <id>. Use read_tool_output to page through it, or pass {"$output":"<id>"} as a tool argument.]`。
- 模型用内置工具 `read_tool_output {id, offset?, limit?, charOffset?}` 按行分页读存档（每次不超过 `tools.maxResultReadChars`）。
- 参数里任意位置的 `{"$output": "<id>"}`（对象恰好只有这一个键）在校验前被替换为该存档全文，所以大结果可以直接传给下一个工具，不经模型上下文。处理函数看到的就是替换后的值。
- 存档**只属于产生它的会话**：`read_tool_output` 与 `$output` 只能读同一会话（且同一组织）的存档，别的会话的 id 一律按「not found or expired」处理（会话之间可见范围不同，不能借 id 跨会话读结果）。
- 因此插件**不要自己截断**大结果或自造分页；返回完整文本即可。真正无界的数据（整库导出）在工具层面设上限或分页参数，并在描述里写明。

## 需要用户输入：`InputRequired` 与续跑

处理函数可以返回 `{ kind: "input_required", form, state? }` 而不是结果：内核校验表单（`validateInputForm`，字段 schema 只用 ParamSchema 子集，枚举可 `multiSelect` / `allowOther`）、建输入请求、run 暂停。用户提交后（或超时 / 取消），内核**用同一 input 再次调用**该处理函数，并带上 `call.resume = { state, answer }`（超时 / 取消时 `answer` 为 `null`）。

```ts
async (input, call) => {
  if (!call.resume) {
    return { kind: "input_required", form: { title: { zh: "确认", en: "Confirm" }, fields: [ /* … */ ] }, state: { step: 1 } };
  }
  if (call.resume.answer === null) throw new ToolError("The user did not answer; ask again later or try another approach.");
  // 用 call.resume.state / answer 继续
}
```

- `state` 可 JSON 序列化、≤ 16 KB；它存在 PG，续跑可能在另一个副本上，**不要把续跑需要的东西放内存**。
- 同一调用最多连续请求输入 3 次，第 4 次 → `Tool requested user input too many times.`
- 内置 `ask_user` 就是用这套机制实现的，可作参考。
- MCP 连接器的 elicitation（远端在调用途中向用户要输入）由内核转成同一套输入请求：内核中止远端调用、用户回答后用**同一 input** 重新发起调用，远端再次发起同样的 elicitation 时用答案答复（至多 3 轮；远端不再问或换了 schema 时答案用不上，elicitation 之前的副作用会重做一次）。这是连接器与内核之间的事，细节见 `skills/writing-connectors`，插件工具不涉及。

## `tool_search`：工具多时的目录与按需加载

可用工具数超过 `tools.searchThresholdTools`（默认 30）或其定义的估算 token 超过 `tools.searchThresholdTokens`（默认 8000），且组织设置 `toolSearch` 为 `on`（默认；admin 经 `PATCH /api/v1/orgs/:orgId/settings {"toolSearch":"on"|"off"}` 改）时，内核对该 agent 启用 `tool_search`（`ToolRegistry.forAgent` 在每步实时判定，由注册表追加，不进 agent 定义）：

- 发给模型的 `tools` 只有内置工具（`ask_user`、`read_tool_output`、`tool_search`，始终完整加载）与**已加载**工具的完整定义；其余工具以「目录」形式出现在 system 的第二个块：每行 `- <key>: <描述的第一行>`（超过 200 字符截断），按 key 排序。目录只依赖工具集合，与加载状态无关，缓存前缀稳定。
- 模型调 `tool_search {query, limit?}`（`limit` 默认 5、最多 10）：对**目录里的工具**按关键词确定性评分（key 里出现的词权重是描述里的 2 倍，稀有词权重更高，同分按 key 排序），返回命中工具的完整定义（名字、描述、inputSchema），并把它们加载到**下一步**起的 `tools` 里。
- 已加载集合 = 会话日志里全部 `tool_result.loadedTools` 的并集（压缩摘要之前的也算；本步已不可用的忽略），所以只由日志还原。同一步里刚被 `tool_search` 加载的工具若立刻被调用会被拒（`Tool "<key>" is not loaded. Call tool_search first…`，模型形成那次调用时并没有它的定义）；调用目录里没加载的工具同理，内核不自动加载。

**对工具作者的含义**：

- **描述会被搜索，也是目录的唯一文字**：写清「做什么、对象、动作」的关键词（`create calendar event`），**第一行**要能单独说明工具用途（目录只取第一行）；把对象和动作的词放进描述或工具名，模型才搜得到。
- 工具名（key）里的词权重更高，起名用动词短语（`search_docs`）有利于命中。
- 不要为了「让模型总能看到」把工具做成内置或加到 agent 的 system 提示里；工具数量大时本来就该走目录。
- 小规模部署（工具少于阈值）下所有工具照旧完整加载，`tool_search` 不出现。

## 工具定义漂移与复核

连接器工具的定义来自远端，可能被改（spec 7.3 防 rug-pull / 工具投毒）。内核（`packages/kernel/src/tools/drift.ts`）每 `tools.driftIntervalHours` 小时、收到连接器的 `onToolsChanged`、管理员 `POST .../connectors/:connectorId/refresh` 时重新 `listTools` 并与快照比对：

- 新增的工具 → `pending_review`；
- **任何 spec 变化**（描述、`inputSchema`、注解、`connectorData`，即 `spec_hash` 或来源变了；`connectorData` 计入哈希）→ `pending_review`，新定义存 `pending_spec`、旧定义保留供对比；管理员停用过的工具变了也一样；变成不合规的定义同样只进 `pending_spec`（工具停用，approve 被拒，reject 清掉），`spec` 始终是上次复核通过的定义；
- 从未复核过的工具（`reviewed_at` 为空：新增待复核、被拒的新工具）没有可比的旧定义，再变时直接替换 `spec`（仍待复核）；
- 消失 → `disabled` 并标记 `missing`（又出现按新增处理）。

`pending_review` / 停用的工具不进 `forAgent`：点名引用的进 `unavailable`（每步提醒模型），`tools: "all"` 引用的进 `hidden`（不提醒，模型调用时给事实原因）。管理员 `POST .../connectors/:connectorId/tools/:name/review {action: "approve" | "reject"}`：approve 采用新定义并启用并记 `reviewed_at`，reject 停用并保留旧定义（从未复核过的工具被拒后 `reviewed_at` 仍为空，之后仍可 approve）；待复核或从未复核过的工具不能经 PATCH 启用。授权按 `spec_hash` 比对，采用新定义后旧的「记住的授权」自然失效。

**默认策略与 `policy_source`**：连接器工具的默认策略（`connector_tools.default_policy`）由注解推导（`policySource: "derived"`），管理员改过则为 `"admin"`。approve 或刷新采用新定义时，`derived` 的按新注解重新推导（注解变严格——如 `readOnlyHint` 变成 destructive——也会跟着变成 ask，不会沿用旧的 allow）；`admin` 的保留，除非工具的来源（`source`）变了。插件 / 内置工具没有这一层：用 `defaultPolicy` 或注解（见上）。

后台检查用的凭据：组织凭据；个人凭据型连接器依次试至多 3 个现任成员的个人凭据（按凭据最近写入时间倒序），没有则跳过并记日志。审计 `connector.tools_drifted`（只有计数）/ `connector.tool_reviewed`。

写连接器的人要注意：`listTools` 的输出必须确定性，否则会反复触发复核（见 `skills/writing-connectors`）。

## 内核内置工具：沙箱与技能

内置工具（`BuiltinTool`）比插件工具多三个可选项：`timeoutMs(input)` 覆盖 `tools.timeoutMs`；`spillChars` 给比
`tools.outputSpillChars` 更低的转存阈值（取两者较小的）；`unavailable()` 返回本部署不可用的英文原因（注册表据此报
不可用）。新内置工具的名字要加进 `BUILTIN_TOOL_NAMES`。内置工具写自己的事件时用 `ctx.runId` 与唯一的幂等键，并在
同一事务里与业务行一起提交。

**沙箱工具**（Ruling M12：key 不含点）：`sandbox_bash`、`sandbox_read`、`sandbox_write`、`sandbox_edit`、
`sandbox_glob`、`sandbox_grep`、`sandbox_deliver`。

- agent 定义显式引用才有（`DEFAULT_AGENT_TOOLS` 不含）；部署没有沙箱插件时报不可用（`unavailable()`）。
- 全部经 `SandboxService.withSandbox`（每个对话一个沙箱，懒创建，见 `skills/writing-sandbox-providers`），把锁关联的
  signal 传给每次提供方调用；路径过 `validateSandboxPath`，`write` / `edit` 拒绝 `/skills`。
- 超时：`sandbox_bash` = `min(timeoutSeconds ?? 120, sandbox.limits.maxCommandSeconds)` 秒加余量（余量 =
  `tools.timeoutMs` + `sandbox.lockWaitSeconds`，盖住等锁与创建 / 恢复）；超过上限的 `timeoutSeconds` 直接报错。
  其他沙箱工具只用余量（deliver 两倍）。提供方的命令时限先到，模型拿到 `timedOut`，沙箱照常可用。
- 转存：`sandbox_bash` 的 `spillChars` 为 30000，大输出照常经 `read_tool_output` / `{"$output": id}` 读。
- 结果前缀提示（英文）：首次使用 `Sandbox started for this conversation (first use)…`，重建
  `Sandbox was recreated; previous files are gone.`，新复制的附件列出路径。每次调用前把对话里已就绪的附件同步到
  `/workspace/attachments/`。
- 默认策略 allow（沙箱是隔离的，D5）；组织设置 `sandboxToolPolicy: "ask"` 时 bash / write / edit / deliver 需要审批，
  **在执行那一刻**读设置，只读的 read / glob / grep 不受影响。
- `sandbox_deliver` 把文件放进对象存储（`kernel/<orgId>/artifacts/<对话>/<id>`，上限 `sandbox.deliverMaxBytes`），
  追加 `artifact_created` 事件，网页「产物」标签从日志重建。

**技能工具**：

- `skill_load {name}` 不进 agent 定义，由注册表自动加入：对话日志里有技能目录快照 `skills_catalog`（运行开始时按
  agent 版本解析、与上一份不同才写，Ruling M17）时出现。它按**最新快照**把名字解析成技能 id、版本与 `source`（对象前缀），
  只按 `source` 精确取文件，核对大小与 sha256。带其他文件的技能复制进沙箱 `/skills/<name>/`（只读，脚本没有可执行位，
  结果提示用 `sh` / `python3` 运行；旧版本留下的文件列为可忽略，Ruling M18）；agent 没有沙箱工具时只返回正文。
  目录的第一份进 system 缓存段，之后的变化在所在位置渲染为英文提醒（只追加），所以改动在**下一次运行开始**才到模型。
- `skill_write {name, description, files}` 要 agent 定义显式引用（`builtin` / `skill_write`）。内核按 name / description
  合成 SKILL.md 的 frontmatter，只收文本、合计 ≤ 1 MiB、每个 agent 最多 50 个自写技能。
  - 私有 agent：默认 allow，直接生成新版本。负责人可在 agent 定义里设 `skills.writePolicy: "ask"`（D10，缺省即 allow，
    不写进定义），此时与共享 agent 一样固定 ask（记住的授权无效），但确认后**直接生效**、不走变更申请。`writePolicy`
    与可见性一样在执行那一刻读 agent **当前版本**（R5），运行中改为 ask 下一次调用即生效；共享 agent 不论取值都走 R3 + R4。
    网页只在私有 agent 的表单上显示这个开关。
  - 共享 agent：在 R3 固定 ask 清单上，**只对共享 agent 生效**（`R3_SHARED_AGENT_ONLY_TOOL_KEYS`，可见性在执行时实时读，
    读不到按共享处理），记住的授权对它无效。发起人确认后生成变更申请（`skills/changes.service.ts`），负责人在收件箱批准前
    只有发起对话能试用；同一对话再写取代旧申请，别的对话写同一技能被拒。
  - 部署设置 `customSkills` 为 `deny` 只挡组织管理员上传技能包，**不影响 `skill_write`**（agent 级技能与共享 agent 的变更由
    R3 / R4 把关）。
  - 成功后在同一事务里追加一份目录快照，同一运行的下一步即可 `skill_load`。代价：对话里第一份目录在运行中途出现时，
    下一步的工具清单多出 `skill_load`，提示缓存失效一次。

## 连接器

连接器（`connector@1`）把远端服务接成连接器，工具由远端决定，上述策略、审批、输出存档、漂移、`tool_search` 全部照常适用。契约、会话生命周期、鉴权注入、`ToolError` 的熔断语义、`connectorData` 路由、`inspect`、elicitation、测试夹具都在 **`skills/writing-connectors`**。参考实现：`plugins/connector-mcp`、`plugins/connector-openapi`。

要点：`ToolError` 的 `kind: "unavailable"` 才计入连接器熔断（见上）；OAuth 全在内核，连接器只做 `auth()` / `onUnauthorized()`；连接器工具的结果与错误由内核按本次注入的凭据打码。

## 测试

- 插件单测：直接调用处理函数（构造 `ToolCallContext`），见 `plugins/todo/test/todo.test.ts`；多副本读写一致用 `createDualReplicaHarness`。
- 连接器的测试夹具（`startFakeMcpServer` / `startFakeOpenApiServer` / `startFakeOAuthServer`）见 `skills/writing-connectors`；漂移检测见 `packages/kernel/test/tools/drift.test.ts`，`tool_search` 见 `packages/kernel/test/tools/tool-search*.test.ts`。
- 内核端到端：model-fake 的 `tool:<key>:<json>` 指令让模型调用指定工具（如 `tool:todo__write:{"todos":[]}`），见 `packages/kernel/test/tools/mcp-e2e.test.ts` 与双副本验收 `packages/kernel/test/tools/m3-segment1.dual.test.ts`（审批跨副本、审批超时、杀 worker 后结果未知、插件启用前后）。
- 沙箱与技能工具：真实内核 + model-fake + 假沙箱插件（`packages/kernel/test/fixtures/plugins/sandbox-fake`）+ SeaweedFS，
  见 `packages/kernel/test/tools/sandbox/sandbox-tools.test.ts`、`packages/kernel/test/skills/skills-runtime.test.ts`、
  `skill-write.test.ts`；双副本验收 `packages/kernel/test/sandbox/m5-segment2.dual.test.ts`（真实 Docker）与
  `packages/kernel/test/skills/m5-segment3.dual.test.ts`（技能变更跨副本批准、脚本进沙箱）。
