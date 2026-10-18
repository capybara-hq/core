---
name: writing-model-providers
description: 新建或修改模型供应商插件时使用（provides model-provider@2，如 plugins/anthropic、plugins/openai、plugins/openai-compatible、plugins/model-fake）：契约、参数声明与标准旋钮、方言预设、原生协议原则、请求映射只追加、opaque 回放、用量语义、错误映射表、不在插件内重试、streamIdleTimeoutMs、用 startFakeModelServer 写夹具与真实接口模式。
---

# 写模型供应商插件

通用的插件写法（清单、配置、ctx、多副本禁令、双副本测试）见 `skills/writing-plugins`，这里只讲 `model-provider@2` 特有的部分。参考实现：`plugins/anthropic`（Messages API）、`plugins/openai`（Responses API）、`plugins/openai-compatible`（Chat Completions + 方言预设）；`plugins/model-fake` 是确定性脚本化模型，给内核测试与无密钥演示用。

## 契约：`model-provider@2`

类型都在 `@capybara-hq/plugin-sdk`（`packages/plugin-sdk/src/model.ts`）。插件清单 `provides: [MODEL_PROVIDER_CAPABILITY_V2]`（即 `model-provider@2`），在 `setup` 里 `ctx.provide(MODEL_PROVIDER_CAPABILITY_V2, provider)`：

```ts
interface ModelProvider {
  listModels(): Promise<ModelInfo[]>;
  /** 事件序列必须以且仅以一个 message_complete 结束；出错抛 ModelError。 */
  stream(req: ModelRequest, opts: { signal: AbortSignal }): AsyncIterable<ModelStreamEvent>;
}
```

- `ModelRequest`：`model`、`system`（`{ text, cache }[]`，稳定内容在前，`cache: true` 的块之后打缓存断点）、`messages`（user / assistant / 中途 `system`）、`tools`、`maxOutputTokens`、`params`（本次调用的参数，见下节；内核已按该模型的声明处理过：丢弃未声明 / 不合法的项、补上默认值）。
- `ModelStreamEvent`：`text_delta`、`thinking_delta`，最后恰好一个 `message_complete { content, stopReason, usage }`。增量拼起来必须等于最终 `content` 里的文本。流被截断（没收到供应商的结束事件）要抛错（一般是 `network`），**不能**拿半截内容发 `message_complete`。
- `ContentBlock`：`text`、`thinking`、`tool_call`、`tool_result`；`text`、`thinking` 与 `tool_call` 可带 `opaque`（见下）。
- `ModelInfo`：`contextWindow`、`maxOutputTokens`、`capabilities`（`tools` / `vision` / `reasoning` / `caching` / `midConversationSystem`；`effort` 已弃用，仅 `@1` 用）、可选 `streamIdleTimeoutMs`、必填 `parameters`（该模型支持的参数声明，可为空数组）。`listModels` 会被内核缓存，失败时内核跳过该供应商并记日志，不影响其他供应商。
- 判断错误一律用 `isModelError(e)` / `isRetryableKind(kind)`（鸭子类型），不要 `instanceof ModelError`：插件可能带着另一份 plugin-sdk。

插件无进程内可变状态：模型信息之类的缓存放 `ctx.kv`（带 TTL，参考 anthropic 的 `models:v2:<id>`，3600 秒），一次调用内的累积器是请求局部变量。

## 参数声明（`ModelInfo.parameters`）

模型在 `parameters` 里声明自己支持的参数；agent 版本的 `modelParams` / `fallbackParams` 按声明校验（保存时严格，运行时宽松），请求带上 `req.params`，插件负责映射到原生请求。**新增参数只改插件，不需要改前端**：网页的 agent 表单直接按声明渲染控件，文案由声明里的 `label` / `description` 提供。

```ts
interface ModelParameter {
  key: string;                       // 标准旋钮名，或 "<插件名>.<名称>"
  standard?: "effort" | "thinking" | "temperature" | "maxOutputTokens"; // 标准旋钮必填且等于 key，厂商参数不得填
  schema: ParamSchema;               // 受限的 JSON Schema 子集
  default?: ParamValue;              // 必须满足 schema
  label: { zh: string; en: string }; // 都必填、非空
  description?: { zh: string; en: string };
}
```

- **schema 只能是这几种**：`{ type: "string", enum: [...] }`、`{ type: "string", maxLength? }`、`{ type: "boolean" }`、`{ type: "number" | "integer", minimum?, maximum? }`。内核自己校验，不引入 ajv。
- **键名**：标准旋钮直接用 `effort` / `thinking` / `temperature` / `maxOutputTokens`；厂商专有参数必须是 `<插件名>.<名称>`，前缀恰好是插件名（`model-fake.style`、`openai-compatible.xxx`）。不合规时该供应商加载阶段即不可用（`assertValidDeclarations` 抛错）。
- **标准旋钮语义**（平台统一，换模型 / 兜底时可迁移，界面专门渲染）：

| 旋钮 | schema | 语义 |
|---|---|---|
| `effort` | `string` enum，`low|medium|high|xhigh|max` 的子集 | 思考深度，档位由模型决定 |
| `thinking` | `string` enum，`off|on|summarized` 的子集 | 思考模式：`off` 关闭，`on` 开启，`summarized` 开启并返回思考摘要 |
| `temperature` | `number`（可带范围） | 采样温度 |
| `maxOutputTokens` | `integer`（可带范围） | 最大输出 token，内核据此覆盖 `runtime.maxOutputTokens`（不超过模型上限） |

- **默认值只在与供应商 API 自身的默认一致时才声明**，这样「未设置」与「设为默认」行为相同；供应商默认值因模型而异或查不到时不要给默认（openai 的 effort、Qwen 的 thinking 都不给）。例外：anthropic 的 thinking 默认 `summarized`（供应商默认不返回思考文本，平台选择返回摘要）。
- 不是所有模型都有所有旋钮：anthropic 没有 `temperature`；openai 只在部署 `reasoningSummary != "off"` 时才声明 `thinking`。不支持的参数不要声明，也不要发。
- 纯函数在 plugin-sdk：`assertValidDeclarations(plugin, decls)`（插件自测与内核加载时用）、`validateParams`、`sanitizeParams`。一致性套件有 `declares valid parameters` 用例。
- 参数的取舍记录在 `model_call` 事件里（`params`、有丢弃时的 `droppedParams`），请求可由日志还原。

## `@1` 兼容

旧契约 `model-provider@1`（`ModelProviderV1` / `ModelInfoV1` / `ModelRequestV1`，`capabilities.effort` + `req.effort`）仍可用：内核经适配层由 `capabilities.effort` 推导 `effort` 旋钮（五档，不带默认值），并把 `params.effort` 映射为 `req.effort`。同一插件两者都提供时用 `@2`。新插件一律写 `@2`，`capabilities.effort` 已弃用。内核的模型列表缓存键带契约主版本、插件版本与部署配置摘要，插件升级或改部署配置后各副本立即按新声明校验，不会读到旧列表。

## 方言预设（OpenAI 兼容接口）

`plugins/openai-compatible` 用官方 `openai` SDK 的 `chat.completions` 接各家 Chat Completions 兼容服务。这类服务的差异（思考字段、用量字段、回放规则）收在 `src/dialects.ts` 的方言里：一个方言是纯数据加无状态的映射函数（`parameters(model)` 声明参数、`applyParams` 写请求体扩展字段、`readDelta` 读思考增量、`replayAssistant` 决定思考如何回放、`usage` 换算用量）。写法要点：

- 每个字段都按供应商官方文档核实，注释里写明出处与核实时间；查不到的字段不实现。
- 方言只看消息自身与请求级设定（模型及其部署属性、是否带工具、参数），不看其他消息——保持「只追加」（见下节）。
- 新增方言：在 `dialects.ts` 加一个 `Dialect`，登记进 `DIALECTS` 与配置里的 `dialect` 枚举，补夹具与错误映射用例。
- 对外模型 id 为 `<端点名>/<模型 id>`；密钥放顶层 `apiKeys`（端点名 → 密钥）——内核只认对象字段路径上的 `secret()`，放进 `endpoints[]` 数组元素里的密钥会导致插件被拒绝加载。

## 原生协议：用官方 SDK，不经兼容层

- 每个供应商用**自家官方 SDK** 调**原生接口**（Anthropic → `@anthropic-ai/sdk` Messages API；OpenAI → `openai` Responses API）。不用 LangChain 的 chat model 封装，不经「OpenAI 兼容」接口转译别家模型（`openai-compatible` 只用于本来就只提供 Chat Completions 的服务，如 DeepSeek、Qwen、vLLM；Anthropic / OpenAI 自家模型仍走各自的原生插件）：兼容层会丢掉思考块签名、加密推理项、缓存断点等供应商私有能力，也会掩盖真实错误类型。
- 模型能力以原生接口为准：能从 Models API 取的就取（anthropic），取不到的由部署配置给出（openai 的 `models[]` 带 `contextWindow` / `maxOutputTokens` / `reasoning` / `vision`）。

## 请求映射只追加

内核保证「发给模型的历史只追加」：较早请求的消息序列是较晚请求的前缀（这也是提示词缓存能命中的前提）。插件的映射必须保住这一点：

- **每条消息的映射只取决于它自己与请求级设定**（请求模型及其属性、请求的 `tools` 与 `params`），**不看其他消息**：不看后续消息、不按后续消息调整顺序、不合并或拆分已发送的消息。写成纯函数 `buildRequest(req)`，单测「请求 A 的映射结果是请求 A + 若干新消息（请求级设定不变）的映射结果的前缀」。例：DeepSeek 方言在带 tools 且未关闭思考的请求里给没有本模型思考的历史回合补空 `reasoning_content`——取决于请求级的 tools / thinking，不取决于其他消息。
  - 代价：请求级设定在两次请求之间变化（如这一轮起带上 tools、或切换 thinking）时，较早回合的序列化随之改变，供应商的前缀缓存在变化点之前失效、多计一次输入费用；内核看到的历史仍然只追加，正确性不受影响。M3 接入工具后，tools 集合在会话中途变化时要留意这一点。
- 中途 `system` 消息：供应商有不需要前后文的原生表达就用（openai 在原位置转成 `developer` 输入项，`midConversationSystem: true`）；原生表达有位置规则、需要看后续消息才能决定怎么放的，**不要用**，在原位置转成 user 文本块 `"[system] " + text`，并报 `midConversationSystem: false`。anthropic 就是这样：原生 system 的放置规则需要前瞻（后面跟着被跳过的空回合或失败的步骤时位置会变），会改写已发送的前缀。
- 供应商私有块（思考、推理项）原样回放，不改写、不重排；不能回放的（见下）整块丢掉。
- 历史缓存断点不要打在「最后一条消息的最后一个块」上：下一轮断点移到新的末尾块，已发送消息的字节随之改变。anthropic 用请求顶层的自动 `cache_control`（API 自己把断点放在最后一个可缓存的块上，占一个断点名额，system 已用满 4 个时不加）；openai 的缓存本来就是按前缀自动的。
- 模型不支持的参数不发，也不声明：anthropic 只对 Models API 报告支持 adaptive 思考的模型声明并发送 `thinking`，`effort` 档位取 Models API 逐档的 `supported`。

## opaque 回放：只回放给同一供应商、同一模型

`opaque = { provider, model, data }` 是供应商私有数据（Anthropic 思考块及其签名、OpenAI 含 `encrypted_content` 的 reasoning 项、function_call 与 message 的输出项 id）。规则：

- 产出时 `data` 存原生块原样（能直接塞回下一次请求），`provider` 填插件名，`model` 填**下一轮能接受它的那个模型 id**：
  - openai 用**请求的** model id（响应里的 `model` 是带日期的快照名，按它打标签下一轮永远对不上）；
  - anthropic 用响应的 `model`；**服务端拒答兜底**（`fallbacks: "default"`）时消息里出现 `fallback` 块，整条消息的思考 / 工具 opaque 都改打 `fallback.to.model`（真正作答的模型），否则下一轮回放给原模型会因签名校验失败被拒（R39）。
- 回放时只在 `opaque.provider === 本插件 && opaque.model === req.model && data != null` 时原样放回；否则：思考块整块丢掉，工具调用退化为不带私有字段的普通调用（openai 去掉输出项 id）。agent 切换模型、走 `fallback` 模型时历史里会混有别的模型的块，这是常态。
- openai 的推理模型要求回放的 reasoning 项**紧跟它产出的输出项**：text 块的 opaque 保存 message 输出项的 `id`（与 `phase`），同一条 assistant 消息里已回放过 reasoning 项时，text 按原 message 项回放（`{ type: "message", id, role: "assistant", status, content: [output_text] }`）；没有回放 reasoning 项时不带 id（单独带 msg_ id 会被拒）。映射只看消息自身，仍然只追加。夹具按这条规则把关，但**真实接口尚未验证**——见下文「发布前必须跑真实接口」。

## 用量语义（`ModelUsage`）

三类输入互不重叠，内核按它们的**和**校正上下文估算、决定何时压缩：

- `inputTokens`：**未缓存**的输入（既没命中缓存、也没写入缓存的部分），不是输入总量；
- `cacheReadTokens`：从缓存读取的输入；`cacheWriteTokens`：本次写入缓存的输入；
- 输入总量 = `inputTokens + cacheReadTokens + cacheWriteTokens`。
- 供应商的输入计数已包含缓存部分时**先减掉**：openai `inputTokens = input_tokens − cached_tokens − cache_write_tokens`（下限 0）；anthropic 的 `input_tokens` 本来就不含缓存读写，直接用。

## 错误映射

一律抛 `ModelError(kind, message, { retryAfterMs?, cause })`。只按 SDK 异常类、HTTP 状态码与结构化错误 `type` / `code` 判断，**不匹配错误信息字符串**。`signal` 已中止时无论 SDK 抛什么都归为 `aborted`。

| kind | 可重试 | 典型来源 |
|---|---|---|
| `rate_limited` | 是 | 429；带 `retry-after-ms`（毫秒）或 `retry-after`（秒 / HTTP 日期）时填 `retryAfterMs` |
| `overloaded` | 是 | anthropic 529 / `overloaded_error` |
| `server` | 是 | 5xx；`api_error` / `server_error`；流中途无法识别的 error 事件 |
| `timeout` | 是 | SDK 连接超时、408、`timeout_error` |
| `network` | 是 | 连接失败、流在结束事件之前断开 |
| `auth` | 否 | 401 / 403；`billing_error`；openai `insufficient_quota`（虽然是 429，重试无用） |
| `invalid_request` | 否 | 其余 4xx；**畸形的工具参数**（见下）；prompt 过长的 400（anthropic 没有专门的类型） |
| `context_overflow` | 否 | 413 / anthropic `request_too_large`；openai `context_length_exceeded` |
| `aborted` | 否 | 调用方中止 |

可重试的由内核降级梯子处理（主模型 → 主模型重试一次，等 `retryAfterMs`，默认 1 秒，超过 10 秒就跳过同模型重试 → agent 的 `fallback` 模型）；不可重试的直接让运行失败（错误码 `model.<kind>`）。分类错了的代价：把请求本身的问题标成可重试会白白重试并切到降级模型；把暂时故障标成不可重试会让本可成功的运行失败。

**畸形的工具参数 → `invalid_request`**：工具输入 JSON 解析失败或不是对象时抛 `invalid_request`。如果 SDK 的流式辅助类会自己预解析工具输入、把解析失败包成没有结构信息的通用异常（anthropic 的 `MessageStream` 就是这样），就不用它：直接用原始事件流（`create({ stream: true })`）、自己累积最终消息并 `JSON.parse`（anthropic / openai 的 `map-stream.ts` 都这样做）。

## 不在插件内重试

SDK 客户端一律 `maxRetries: 0`。重试、等待、降级、`step_reset` 都在内核统一做；插件内再重试会叠加等待、绕过 10 秒上限，并让 `model_call` 事件对不上实际请求次数。插件也不要自己设请求超时去兜底空闲流——那是内核看门狗的事（见下）。

## `streamIdleTimeoutMs`

内核的看门狗在两次流事件之间超过阈值时本地中止并按 `timeout` 处理（可重试）。阈值取 `ModelInfo.streamIdleTimeoutMs`，没给时用内核配置 `runtime.streamIdleMs`（默认 60000）。

- 普通对话模型可以不填，用内核默认；
- 推理 / 思考阶段可能长时间不发事件的模型要填大：anthropic 统一 300000（5 分钟）；openai 由部署配置 `models[].streamIdleTimeoutMs` 按模型给；
- 太小会把正常的长思考当成卡死反复重试，太大则真卡死时要等很久才进入降级。

## 测试：夹具模式与真实接口模式

每个供应商插件都跑 `@capybara-hq/testing` 的一致性套件 `describeModelProviderConformance(name, setup)`（流式文本、工具往返、思考回放、缓存、用量、中途 system、中止）。两种模式写在同一个 `test/conformance.test.ts` 里：

```ts
import { describeModelProviderConformance, startFakeModelServer } from "@capybara-hq/testing";
import { describe } from "vitest";
import { createMyProvider } from "../src/index.js";
import { myRoutes } from "./fixtures.js";

// 夹具模式：本地假服务按原生协议回放，CI 默认跑
describeModelProviderConformance("my (fixtures)", async () => {
  const server = await startFakeModelServer(myRoutes());
  return {
    provider: createMyProvider({ apiKey: "sk-fixture", baseUrl: server.url, /* … */ }),
    model: "my-model",
    expect: { thinking: true, caching: true },
    teardown: () => server.stop(),
  };
});

// 真实接口模式：设了密钥才跑
const LIVE_KEY = process.env.CAPYBARA_TEST_MY_API_KEY;
describe.skipIf(!LIVE_KEY)("live", () => {
  describeModelProviderConformance("my (live)", async () => ({
    provider: createMyProvider({ apiKey: LIVE_KEY ?? "" }),
    model: "my-cheap-model",
    expect: { thinking: true, caching: true },
    cachePrefixTokens: 6000, // 稳定前缀要超过该模型的最小可缓存长度
    teardown: async () => {},
  }));
});
```

- `startFakeModelServer(routes)`：`routes(req)` 收到 `{ path, body, headers }`，返回 `{ status, json, headers? }`（普通 / 错误响应）、`{ status: 200, sse: [{ event?, data }], delayMs? }`（SSE）或 `{ stall: true }`（只发响应头、不发数据，用来测中止与看门狗）。`server.requests` 记录全部请求，可断言实际发出的原生请求体。夹具按供应商原生格式手写在插件的 `test/fixtures.ts`（参考 `plugins/anthropic/test/fixtures.ts` 的 `sseMessage`、`errorJson`），不要录制真实响应里的密钥。
- 插件构造函数要接受 `baseUrl`，夹具模式靠它指向假服务。
- 一致性套件之外，按上面的错误映射表逐行写用例（429 带 `retry-after`、529、5xx、401/403、400、413、流中途 error 事件、流截断、畸形工具参数、网络失败、中止、停滞流中止），以及请求映射的前缀单测。
- 真实接口模式：anthropic 设 `CAPYBARA_TEST_ANTHROPIC_API_KEY`（跑 `claude-haiku-5-5`）；openai 设 `CAPYBARA_TEST_OPENAI_API_KEY` 与 `CAPYBARA_TEST_OPENAI_MODEL`；openai-compatible 设 `CAPYBARA_TEST_OAICOMPAT_BASE_URL` / `_API_KEY` / `_MODEL` / `_DIALECT`（`generic` / `deepseek` / `qwen`，四个都设才跑）。已用真实接口验证过：anthropic（`claude-haiku-5-5`）、DeepSeek（`deepseek-flash`，方言 `deepseek`）、openai（`gpt-5-nano`）。未设置时测试打一行 info 说明已跳过。改了请求映射或升级 SDK 后在本地用真实接口跑一遍。
- **发布前必须跑真实接口**：CI 没有密钥，夹具只是按文档与已知报错手写的近似。每次发布供应商插件之前，用真实接口把一致性套件跑通（尤其是思考回放：openai reasoning 项 + 带 id 的 message 项、anthropic 签名思考块，以及顶层 `cache_control` 的缓存命中），并在发布说明里写明跑过的模型。
- `plugins/model-fake` 同样跑这套一致性套件（不需要假服务；声明 `effort` 三档与 `model-fake.style`）；它的脚本语法（`echo:`、`slow:<ms>:`、`stall`、`fail:<kind>`、`tool:<name>:<json>`、`long:<n>`，其余文本回复 `You said: …`）见其源码 `src/script.ts`。

## 模型或网关补丁只放在插件里，并写明何时可以删除

某个模型或网关的特殊处理（某参数在某些模型上会 400、某字段需要特殊值、某网关不支持某个头）**只写在对应插件里**，内核与 SDK 契约保持供应商无关。每处补丁就地写注释，说明：

1. 补的是什么问题（哪个模型 / 网关、什么现象）；
2. **何时可以删除**（供应商修复后、某模型下线后、SDK 某版本之后）。

例：anthropic 不设 `tool_choice`（`any` / `tool` 在当前模型上会 400，模型支持后可去掉）；思考块用 `display: "summarized"`（当前模型默认 `omitted` 不返回思考文本）。只写「workaround」而不写删除条件的补丁会永远留下来。

## 新供应商插件清单

1. 按 `skills/writing-plugins` 建插件包（`@capybara-hq/plugin-<name>`），依赖官方 SDK 与 `@capybara-hq/plugin-sdk`，devDependency `@capybara-hq/testing`。
2. 部署配置：`apiKey` 用 `secret(...)`，可选 `baseUrl`，模型清单；SDK 客户端 `maxRetries: 0`。`listModels` 返回的每个模型带 `parameters`，并在测试里过 `assertValidDeclarations`。
3. `map-request.ts`（纯函数、只追加）、`map-stream.ts`（原始事件流累积、opaque、用量）、`errors.ts`（按上表映射）。
4. 夹具模式一致性套件 + 错误映射用例 + 映射前缀单测；真实接口模式本地跑通。
5. README 的「模型供应商插件」表加一行与配置示例；`pnpm changeset`（新插件 minor）。
