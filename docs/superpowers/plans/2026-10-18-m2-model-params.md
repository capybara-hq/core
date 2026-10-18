# M2 补充：模型参数由插件声明 + openai-compatible 插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec 4.5（2026-10-18 调整）实现两件事：一是「模型参数由插件声明、界面照声明渲染」的 `model-provider@2` 契约，二是默认发行版自带的 `openai-compatible` 插件（含 DeepSeek / Qwen 方言预设）。同时把现有的 `anthropic`、`openai`、`model-fake` 插件和网页的 agent 表单迁移到新契约。

**Architecture:**
- **参数声明**：每个模型在 `ModelInfo.parameters` 中声明自己支持的参数，取值约束用受限的 JSON Schema 子集描述，便于序列化后交给界面。
- **两层参数**：
  - 标准旋钮（`effort` / `thinking` / `temperature` / `maxOutputTokens`）由平台统一语义，界面为它们做专门控件；
  - 厂商专有参数（键名带插件名前缀）由界面按声明通用渲染。
- **内核职责**：agent 版本里保存主模型和兜底模型各自的参数；保存时按该模型的声明校验；运行时原样放进 `ModelRequest.params`，并写入 `model_call` 事件。
- **兼容**：内核同时支持 `model-provider@1` 和 `@2`（spec 2.5）。`@1` 的插件经适配层接入：只支持 effort 一个标准旋钮，由旧的 `capabilities.effort` 推导出来。

**Tech Stack:** 同 M2；`openai-compatible` 插件使用 `openai` SDK 的 `chat.completions` 流式接口，并配置 `baseURL`。

**Spec:** `docs/superpowers/specs/2026-10-17-capybara-architecture-design.md` 4.5（2026-10-18 调整）、2.2、2.5。主计划：`docs/superpowers/plans/2026-10-17-m2-agent-runtime.md`（全局约束沿用）。

## Global Constraints

- 沿用 M2 主计划的 Global Constraints 全文，以及 M2 执行期的全部裁决（台账存档：`/private/tmp/claude-501/-Users-grant-Capybara-core--claude-worktrees-feat-m2-agent-runtime/e188ef88-b711-4713-b4be-9a7ea8566551/scratchpad/m2-sdd-ledger.md`）。重点几条：
  - 发给模型的历史只追加；
  - 用量语义：`inputTokens` 只计未命中缓存的输入；
  - 用 `isModelError` 判断模型错误；
  - 插件在原始事件流上自行累积，工具参数 JSON 格式错误判为 `invalid_request`。
- **参数声明只能使用这个 JSON Schema 子集**：`{type:"string", enum:[...]}`、`{type:"boolean"}`、`{type:"number"|"integer", minimum?, maximum?}`、`{type:"string", maxLength?}`。内核自己实现校验，不引入 ajv。
- **参数键名**：标准旋钮直接用 `effort`、`thinking`、`temperature`、`maxOutputTokens`；厂商专有参数必须形如 `<插件名>.<名称>`（例如 `deepseek.search`）。插件声明了不合规的键名时，加载阶段直接报错。
- **界面文案**：参数文案由插件提供，形如 `label: { zh, en }`，`description` 同理。网页的其余文案仍走 next-intl。
- **不引入新的 UI 库或样式库**：另一个会话正在建设计系统。新组件只用现有写法，保持简单。

## Review Focus

1. **标准旋钮跨模型迁移**：agent 的主模型和兜底模型来自不同厂商、各自的 effort 档位集合不同时，各自按自己的声明校验；兜底时只使用兜底模型自己那份参数。→ Task 20 测试。
2. **插件升级后某个参数被移除或值域变窄**：已保存的 agent 在运行时遇到不再合法的参数，丢弃该参数、用该模型声明的默认值，并在 `model_call` 中记录 `droppedParams`，不让整轮运行失败。保存新版本时则严格校验。→ Task 20 测试。
3. **DeepSeek 的 `reasoning_content`**：作为思考增量流出，`message_complete` 中成为 thinking 块；下一轮回传时，按 DeepSeek 的规则不把 `reasoning_content` 发回（多轮对话中发回会被 API 拒绝）。→ Task 21 测试。
4. **`@1` 插件不改代码继续可用**：只声明了 `capabilities.effort` 的旧插件，effort 仍然生效。→ Task 19 测试。
5. **界面遇到未知参数类型**：插件声明了界面不认识的 schema（例如带 maxLength 的字符串），用文本输入框兜底渲染，不报错。→ Task 23 测试。

---

### Task 19: `model-provider@2` 契约与内核适配

**Files:**
- Modify: `packages/plugin-sdk/src/{model,capability}.ts`、`packages/testing/src/model-conformance.ts`、`packages/kernel/src/runtime/providers.ts`、`packages/kernel/src/plugins/host.ts`（`@2` 插件声明的参数键名在加载时校验）
- Test: `packages/plugin-sdk/test/model.test.ts`、`packages/kernel/test/agents/providers.test.ts`、`packages/testing/test/model-conformance.test.ts`

**Interfaces:**
- Produces（plugin-sdk）：
  ```ts
  export type StandardKnob = "effort" | "thinking" | "temperature" | "maxOutputTokens";
  export type ParamSchema =
    | { type: "string"; enum: string[] } | { type: "string"; maxLength?: number }
    | { type: "boolean" } | { type: "number" | "integer"; minimum?: number; maximum?: number };
  export interface ModelParameter {
    key: string;                       // 标准旋钮名或 "<plugin>.<name>"
    standard?: StandardKnob;           // key 为标准旋钮时必须等于 key
    schema: ParamSchema;
    default?: string | number | boolean;
    label: { zh: string; en: string };
    description?: { zh: string; en: string };
  }
  // ModelInfo 新增：parameters: ModelParameter[]（@2 必填；@1 由适配层补）
  // ModelRequest 新增：params: Record<string, string | number | boolean>（@2 使用；保留 effort? 供 @1）
  export const MODEL_PROVIDER_CAPABILITY_V2 = "model-provider@2";
  export function validateParams(decl: ModelParameter[], params: Record<string, unknown>):
    { ok: true; value: Record<string, string|number|boolean> } | { ok: false; issues: { key: string; message: string }[] };
  export function sanitizeParams(decl: ModelParameter[], params: Record<string, unknown>):
    { value: Record<string, string|number|boolean>; dropped: string[] };   // 运行时宽松版：丢弃非法项，补默认值
  export function assertValidDeclarations(plugin: string, decl: ModelParameter[]): void;  // 键名与 standard 规则
  ```
  - 标准旋钮的语义约定（写在 JSDoc 里）：
    - `effort`：string 枚举，取值是 `low|medium|high|xhigh|max` 的子集；
    - `thinking`：string 枚举，取值是 `off|on|summarized` 的子集；
    - `temperature`：number；
    - `maxOutputTokens`：integer。
  - `validateParams` 和 `sanitizeParams` 都是纯函数，返回的 issue `message` 用英文。
- 能力登记：`model-provider` 维持多选基数，`@1` 与 `@2` 并存。`PluginHost.list("model-provider")` 返回两种主版本。
- **内核 `ProviderRegistry`**：
  - 遇到 `@1` 插件时用适配层包一层：`parameters` 由 `capabilities.effort` 推导，为真时补一个 `effort` 旋钮，枚举五档、默认 `high`；`stream` 时把 `params.effort` 映射到 `req.effort`，其余参数丢弃。
  - 遇到 `@2` 插件时，`listModels` 的结果先过一遍 `assertValidDeclarations`。
  - 同一个插件同时提供 `@1` 和 `@2` 时，优先用 `@2`。
- **一致性测试套件**：新增用例 `declares valid parameters`，要求 `@2` 插件的每个模型都通过 `assertValidDeclarations`，且每个声明的默认值都能通过 `validateParams`。

- [ ] **Step 1: 写失败测试**：
  - `validateParams` / `sanitizeParams`（表驱动）：枚举越界、类型不符、未知键、超出数值范围、默认值补齐、`dropped` 列表；
  - `assertValidDeclarations`：键名 `foo` 不带前缀 → 抛错；`standard: "effort"` 但 `key: "x.effort"` → 抛错；
  - 适配层：只有 `capabilities.effort` 的 `@1` 桩插件 → `parameters` 含 effort；`stream` 收到 `params.effort` 时，透传给 `req.effort`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**；全量全绿。
- [ ] **Step 5: 提交** `feat(plugin-sdk): model-provider@2 参数声明契约与内核适配`。

### Task 20: agent 模型参数的保存、校验与运行时透传

**Files:**
- Modify: `packages/kernel/src/agents/{definition,agents.service}.ts`、`packages/kernel/src/runtime/{model-call,context/build}.ts`、`packages/kernel/src/conversations/events.ts`
- Test: `packages/kernel/test/agents/*`、`packages/kernel/test/runtime/{model-call,context/build}.test.ts`

**Interfaces:**
- **`AgentDefinitionSchema` 变更**：
  - 删除 `effort` 字段。M2 尚未发布，直接替换，不做兼容。
  - 新增 `modelParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({})` 与 `fallbackParams`（同类型，默认 `{}`）。
- **`AgentsService.create/update`**：解析出模型后，用 `validateParams(info.parameters, …)` 校验主模型和兜底模型各自的参数；不合法时返回 400 `validation_failed`，`details` 为 `{ path: "modelParams.<key>", message }[]`。
- **`runModelStep`**：
  - 主模型尝试用 `sanitizeParams(info.parameters, agent.modelParams)`，兜底尝试用兜底模型自己的 `fallbackParams`。
  - `params` 放进 `ModelRequest`。`maxOutputTokens` 旋钮存在时覆盖 `runtime.maxOutputTokens`，但不超过模型的 `maxOutputTokens`。
  - `model_call.request` 新增 `params` 与 `droppedParams?: string[]`，取代原有的 `effort` 字段（M2 未发布，直接替换）。
- **`buildModelRequest`**：不再读取 `agent.effort`。参数由 `runModelStep` 注入，构建出的请求仍能从日志里的 `model_call.request.params` 还原。

- [ ] **Step 1: 写失败测试**：
  - **保存校验**：主模型为 model-fake、兜底模型为 model-fake-b，effort 档位集合不同，各自校验（Review Focus 1）；未知键返回 400 并点名。
  - **运行时宽松处理**：把已保存定义里的参数改成不再合法的值（直接改库模拟插件升级）→ 运行成功，`model_call.request.droppedParams` 含该键，请求使用默认值（Review Focus 2）。
  - **兜底参数**：兜底尝试的 `model_call.request.params` 等于 `fallbackParams` 经过 sanitize 的结果。
  - **还原性**：构建测试通过 `model_call.request.params` 还原出相同的请求。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**；全量全绿。
- [ ] **Step 5: 提交** `feat(kernel): agent 模型参数按插件声明校验并透传`。

### Task 21: `openai-compatible` 插件（含 DeepSeek / Qwen 方言）

**Files:**
- Create: `plugins/openai-compatible/{package.json,src/index.ts,src/dialects.ts,src/map-request.ts,src/map-stream.ts,src/errors.ts,test/fixtures.ts,test/map.test.ts,test/conformance.test.ts}`

**Interfaces:**
- 插件 `@capybara-hq/plugin-openai-compatible`，name 为 `openai-compatible`，提供 `model-provider@2`。
- **部署配置**：
  ```ts
  {
    endpoints: {
      name: string;                        // 端点名；多个端点可共存，例如自建 vLLM 与 DeepSeek
      baseUrl: string; apiKey: secret(z.string()).optional();
      dialect: "generic" | "deepseek" | "qwen";
      models: { id: string; contextWindow: number; maxOutputTokens: number; vision?: boolean;
                reasoning?: boolean; caching?: boolean; streamIdleTimeoutMs?: number }[];
    }[]
  }
  ```
  - 对外的模型 id 为 `<端点名>/<模型 id>`，例如 `deepseek/deepseek-chat`。
- **方言（`dialects.ts`）**：每种方言是一个纯数据加映射函数的对象 `{ parameters(model): ModelParameter[]; applyParams(body, params); readDelta(delta): { text?: string; reasoning?: string }; replayAssistant(blocks): ChatCompletionAssistantMessageParam; usage(raw): ModelUsage }`。
  - **generic**：标准旋钮只有 `temperature`、`maxOutputTokens`；`reasoning_content` 不处理。
  - **deepseek**：
    - 推理模型从 `delta.reasoning_content` 读出思考增量，生成 thinking 块，`opaque` 记录 provider 与 model；
    - **回传时不把 `reasoning_content` 发回**（Review Focus 3）；
    - 用量：`prompt_cache_hit_tokens` 记为 `cacheReadTokens`，`prompt_tokens` 减去它得到 `inputTokens`；
    - 厂商专有参数在核实 DeepSeek 文档后再声明（不确定就不加）。
  - **qwen**：
    - 推理模型声明 `thinking` 标准旋钮（`off|on`），映射为请求体里的 `enable_thinking: boolean`；
    - 同样从 `reasoning_content` 读出思考增量。
  - 方言的具体字段，必须在实现时查官方文档或 SDK 类型核实。查不到的字段不要实现，在报告里列出。
- **请求与流**：
  - 用 `openai` SDK 的 `chat.completions.create({ stream: true, stream_options: { include_usage: true } })`，在原始 chunk 上自行累积：文本、思考、`tool_calls`（按 index 累积 `function.arguments`，结束时 `JSON.parse`，失败判为 `invalid_request`）。
  - `finish_reason` 映射：`stop` → `end_turn`，`tool_calls` → `tool_use`，`length` → `max_tokens`，`content_filter` → `refusal`。
  - 中途的 system 消息一律作为 `role: "system"` 消息放在原位置（Chat Completions 允许出现在任意位置），保持只追加；不支持该写法的方言改用 `[system] ` 开头的 user 文本。
  - 收到 `finish_reason` 并拿到最后一个用量 chunk 后停止读取。
  - 错误映射复用 openai 插件的规则，SDK 客户端 `maxRetries: 0`。
- **一致性测试**：
  - 夹具模式：用 Chat Completions 的 SSE 格式编写夹具，generic、deepseek、qwen 各跑一遍。
  - 真实接口模式：设置了 `CAPYBARA_TEST_OAICOMPAT_BASE_URL`、`CAPYBARA_TEST_OAICOMPAT_API_KEY`、`CAPYBARA_TEST_OAICOMPAT_MODEL`、`CAPYBARA_TEST_OAICOMPAT_DIALECT` 时运行，可直接用 DeepSeek 的密钥。

- [ ] **Step 1: 写失败测试**：
  - `map.test.ts`：只追加的前缀测试（含 thinking 与 tool 往返）；deepseek 回传不带 `reasoning_content`；qwen 的 `thinking: off` 映射为 `enable_thinking: false`；用量换算。
  - `conformance.test.ts`：三种方言的夹具一致性测试；`tool_calls` 参数 JSON 格式错误判为 `invalid_request`；收到 `finish_reason` 后停读（连接保持打开不影响完成）。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**；在根目录 devDependencies 中加入该插件。
- [ ] **Step 4: 运行确认通过**；有 DeepSeek 密钥的环境变量时跑真实接口模式，并记录结果。
- [ ] **Step 5: 提交** `feat(plugins): openai-compatible 供应商插件（DeepSeek / Qwen 方言）`。

### Task 22: 现有插件迁移到 `@2`

**Files:**
- Modify: `plugins/{anthropic,openai,model-fake}/src/*`，以及各自的测试

**Interfaces:**
- 三个插件都改为提供 `model-provider@2`。
- **`anthropic`**：
  - `effort` 旋钮：仅当模型的 Models API 能力中 `effort.supported` 为真时声明，档位取 API 支持的集合，没有集合信息时用五档；
  - `thinking` 旋钮：仅在支持 adaptive 时声明，取值 `on|summarized`（当前模型不能关闭思考，所以不提供 `off`），默认 `summarized`，`on` 映射为 `display: "omitted"`；
  - 不声明 `temperature`（当前模型不接受非默认值）。
- **`openai`**：
  - 推理模型声明 `effort` 五档；
  - 部署配置里的 `reasoningSummary` 保留为部署级默认值，另外声明 `thinking` 旋钮（`on|summarized`，映射为是否带 `reasoning.summary`）。
- **`model-fake`**：
  - 声明 `effort`（三档）和一个厂商专有参数 `model-fake.style`（`plain|shout`，`shout` 时回复转大写），供测试和演示界面使用。
- 删除 `capabilities.effort`，由 `parameters` 取代。`@1` 适配层仍认这个字段，为第三方的 `@1` 插件保留。

- [ ] **Step 1: 写失败测试**：三个插件各自的 `parameters` 声明；参数正确映射到原生请求（`anthropic` 的 `thinking: on` 映射为 `display: "omitted"`；`model-fake` 的 `style: shout` 让回复变成大写）；一致性测试新增的 `declares valid parameters` 用例通过。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**；全量全绿。
- [ ] **Step 5: 提交** `refactor(plugins): anthropic / openai / model-fake 迁移到 model-provider@2`。

### Task 23: 网页 agent 表单按声明渲染参数

**Files:**
- Create: `apps/web/src/components/ModelParams.tsx`、`apps/web/test/model-params.test.tsx`
- Modify: `apps/web/src/components/AgentForm.tsx`、`apps/web/messages/{zh,en}.json`、`apps/web/src/components/MessageList.tsx`（思考区按 `capabilities.reasoning` 显示）

**Interfaces:**
- `ModelParams({ parameters, value, onChange, locale })`，渲染规则：
  - **标准旋钮**用专门控件：
    - `effort` 用分段按钮，按声明顺序排列；
    - `thinking` 用分段按钮；
    - `temperature` 用滑块加数字框；
    - `maxOutputTokens` 用数字框。
  - **厂商专有参数**按 schema 渲染：枚举 → 下拉框；布尔 → 开关；带范围的数字 → 滑块；其余 → 文本框（Review Focus 5）。
  - 文案取 `label[locale]`，缺失时回退到 `en`；`description` 显示为提示文字。
  - 未改动的参数不提交，由后端补默认值。
- `AgentForm`：
  - 切换主模型或兜底模型时，重新渲染对应的参数区，并丢弃新模型没有声明的键；
  - 保存时提交 `modelParams` 与 `fallbackParams`；
  - 后端返回 `validation_failed` 时，把 `details` 映射到对应字段。
- 只用现有组件写法，不引入新库（见 Global Constraints）。

- [ ] **Step 1: 写失败测试**：
  - 标准旋钮渲染出专门控件；
  - 厂商枚举渲染为下拉框；
  - 未知 schema 渲染为文本框；
  - 切换模型时丢弃旧键；
  - 校验错误显示在对应字段旁（zh 与 en 各断言一次）。
  - 在 e2e 中加一步：新建 agent 时把 `model-fake.style` 设为 `shout`，回复为大写。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**；web 构建、e2e 与 `pnpm check`（i18n）全绿。
- [ ] **Step 5: 提交** `feat(web): agent 表单按模型声明渲染参数`。

### Task 24: 文档、默认发行版与验收

**Files:**
- Modify: `skills/writing-model-providers/SKILL.md`、`README.md`、`AGENTS.md`（如有必要）、`docs/superpowers/plans/2026-10-17-mvp-roadmap.md`、`.changeset/*`

**Interfaces:**
- **技能文档**：写明 `@2` 契约、参数声明规则、标准旋钮语义表、方言预设的写法、`@1` 兼容说明，以及「新增参数不需要改前端」。
- **README**：
  - 默认示例改用 `openai-compatible` 接 DeepSeek（给出配置示例）；
  - 无密钥的演示仍用 `model-fake`；
  - 说明 `anthropic` 和 `openai` 插件需要按需安装。
- **路线图**：在 M2 行补记「模型参数插件化 + openai-compatible」；在 M6 一栏写明「默认镜像只带 openai-compatible」。
- **changeset**：
  - `plugin-sdk` minor（`@2` 契约）；
  - kernel minor；
  - `plugin-openai-compatible` minor；
  - 三个已有插件 minor；
  - 与已有的 changeset 不得冲突。

- [ ] **Step 1**：更新文档与 changeset；全量 `pnpm lint && pnpm typecheck && pnpm check && pnpm test`、web 构建与 e2e 全绿。
- [ ] **Step 2: 提交** `docs: 模型参数插件化与默认发行版说明`。

---

## 执行顺序

T19 → T20 → T21 → T22 → T23 → T24，串行执行。T20、T22 都依赖 T19 的契约；T23 依赖 T20、T22 产出的声明与接口。
