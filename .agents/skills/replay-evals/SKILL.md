---
name: replay-evals
description: 改动请求构建（runtime/context/build.ts、model-call.ts、事件日志里模型可见的内容）、轨迹查看器或评测（packages/kernel/src/evals：评测集、用例快照、单步 / 整轮回放、评委、评测运行）时使用：回放不变式与零漂移夹具测试（reconstruct.test.ts、rename-compat.test.ts）、新的模型可见输入要进日志并加 DriftReason、整轮回放只用记录的工具结果（RecordedToolPipeline、不执行工具）、评测队列 cap-kernel-evals 与组织并发、token 上限与计费、评委用途 eval，以及隐私规则（轨迹 404、trajectory.viewed 审计、无导出）。
---

# 评测与回放

代码在 `packages/kernel/src/evals/`；HTTP 在 `/api/v1/orgs/:orgId/trajectories*`（`trajectories.read`）、`/eval-sets*`、
`/eval-runs*`、`/eval-results/:id/label`（`evals.manage`）。网页：轨迹查看器 `/trajectories`、评测 `/evals`（`TracePage`，
见 `.agents/skills/writing-web-ui`）。设计依据：总设计 §6 原则 8、M6 计划 C1–C9（D2–D6）。

## 回放的不变式（先看这个）

**事件日志是唯一事实源**：任一次模型请求都能由「日志 + agent 版本」还原。回放只读用例快照，不改原对话的日志。

- `reconstructRequest`（`evals/reconstruct.ts`）与运行时共用 `assembleModelRequest`（`runtime/model-call.ts`），
  输入全部取自日志：`model_call` 事件记录的 `toSeq`、`absorbedUpToSeq`、`params`、`toolChoice`、`maxOutputTokens`、
  `mediaBudgetBytes`、工具 specHash 序列与 system 指纹；工具定义按 specHash 从快照取。
- **改请求构建之前和之后都要跑两组零漂移测试**：
  - `packages/kernel/test/evals/reconstruct.test.ts`（「基线零漂移」：多步工具、`tool_search` 加载、审批续跑、技能目录快照、
    提醒、插话、压缩、图片 / 占位等，用真实运行产生的日志还原，要求 `drift` 为空、还原出的请求与当时发给模型的请求相同）；
  - `packages/kernel/test/tools/rename-compat.test.ts`（T22 改名前录下的夹具 `test/evals/fixtures/pre-rename/`，旧形
    `{kind:"app", appId}` 与 `appId` 事件字段要零漂移）。
  从仓库根跑：`pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts`。
- **新增任何模型可见的输入都必须进日志**（写进事件或 `model_call` 的记录），不能在构建请求时临场读 PG / 配置 / 时钟；
  同时给 `DriftReason`（`reconstruct.ts`，并按顺序加进 `DRIFT_ORDER`）加一个对应原因，用来标出「老日志里没有这项记录」
  或「还原时取不到」的情况，并在 `reconstruct.test.ts` 的「漂移原因」组里加用例。现有原因：`system_hash`、
  `tools_changed`（只在基线判定）、`tool_spec_missing`、`definition_missing`、`legacy_event`、`params_changed`、
  `media_missing`、`media_changed`（只在基线判定）、`tool_unmatched`（整轮回放）。
- 给模型的历史只追加；回放里出现的模型可见文案（如 `REPLAY_NO_RECORDING`）一律英文。

## 用例快照与评测集

- 一个评测集对应一个 agent（C4）。组织管理员从真实对话加用例（按运行）或抽样；运行须已到终态（`eval.run_not_finished`）。
- 快照（`evals/snapshot.ts`，存 `eval_cases.snapshot`）= 截至该运行终态的事件 + 引用的 agent 版本定义 + 请求用到的工具定义
  （按 specHash）；序列化后 ≤ `evals.maxCaseBytes`（`eval.case_too_large`），每集 ≤ `evals.maxCasesPerSet`。
  媒体不复制字节，回放时按引用取原附件，已删除的按「不再可用」占位（`media_missing`）。
- 写入用例时由快照算好回放计划（`evals/plan.ts`，存 `plan_step` / `plan_run`）；估算与启动只读计划列，不读快照。
- 读快照一律经 `readSnapshot`：它把改名前的 `{kind:"app", appId}` 规范化为 connector 形（C27）。
- 删除评测集：用例硬删（结果级联），集合行留作软删除的存根（Ruling S1-a），进行中的运行取消、评测对话删除。

## 两种回放

- **单步回放**（`step-replay.ts`，C5）：沿用记录的工具定义，只换 system（指令）、模型与参数；每个可回放的模型调用一条结果。
  候选 = 可选 agent 版本 + 可选模型 / 参数（`modelParams`，按候选模型的声明校验，`eval.candidate_invalid`）/ 指令覆盖。
- **整轮回放**（`run-replay.ts`，C6）：在 `kind = 'eval'` 的隐藏对话里跑**同一个** `LangGraphLoop`，工具管线换成
  `RecordedToolPipeline`（`recorded-tools.ts`）：
  - **从不执行任何工具**：不经策略、审批、沙箱、连接器，也不调用任何处理函数；按 (toolKey, 规范化参数) 精确匹配第一条
    未用的记录，匹配不上返回英文错误结果 `REPLAY_NO_RECORDING`（`isError: true`），记 `tool_unmatched`。
  - 种子事件保留原 seq；原运行中途吸收的插话在原吸收步骤喂入；崩溃后该用例删掉旧评测对话从头重跑。
  - 评测对话在普通对话接口里一律 404；不做真实工具回放（D2）。
- 评分（`diff.ts`、`judge.ts`）：结构差异（工具调用 / 参数、文本 LCS 相似度，C8）+ 可选 LLM 评委 + 查看器里人工通过 / 不通过。
  评委用模型用途 `eval`（`model_purpose_mappings`，部署默认、组织可覆盖；开评委而未映射 → `model.unconfigured`），
  输出上限 `evals.judgeMaxOutputTokens`；被比较的内容只作数据放进用户消息。

## 评测队列、并发与 token 上限

- 队列 `cap-kernel-evals`，每用例一个任务 `eval-<runId>-<caseId>`（队列名与 job id 不含 `:`），只在 `worker` 角色上消费，
  每副本 `evals.workerConcurrency` 个。组织并发配额是 Redis ZSET `capk:org-evals:<orgId>`，上限 `evals.orgConcurrency`
  （默认 2，可热更），拿不到配额的任务延后 5 秒。
- 运行前估算（`POST …/runs/estimate`，D5）给出预计请求数、token 与默认 / 最大 / 生效上限；`tokenCap` 缺省
  `evals.defaultTokenCap`，不得超过 `evals.maxTokenCap`（`eval.token_cap_invalid`）。
- 计费（`budget.ts`）：用量 = input + output + cache 读 + cache 写，`consumeTokens` 在 PG `eval_runs.tokens_used` 原子累加，
  累加后达到上限即置 `capped`，之后不再发新请求；在途请求可以超出（每个并发任务最多多一次）。**发出后失败的尝试按估算同样
  计入**，失去认领的旧执行已发出的请求也计入（Ruling P2）；评委请求同样计入。
- 每次模型请求前查运行仍活跃（未取消 / 未达上限 / 组织与 agent 未删除）且仍持有认领；结果按认领号写入。连续
  `evals.maxConsecutiveErrors` 条结果出错 → 运行 `failed`。agent 已删除的集合不能再估算 / 启动（`agent.not_found`）。
- 供应商插件在请求途中被撤销 / 升级 / 重新加载（`PluginUnloadedError`，如改了非热更的部署配置）：与运行时一致按可重试的
  `run.provider_unavailable` 处理，单步回放与评委请求都重试（失败的尝试照样按估算计费），重试时实时取到新实例；不记错误、不动熔断。运行状态：`queued` / `running` / `completed` / `cancelled` /
  `capped` / `failed`；结果状态：`pending` / `running` / `done` / `error` / `skipped`。

## 轨迹查看器与隐私

- `trajectories.read`（member 起）之后服务里再判定「组织管理员或该 agent 的负责人」（实时读负责人）；评测回放对话
  （`kind = 'eval'`）只给组织管理员（Ruling S1-c）。**无权查看与不存在一律 404**（`trajectory.not_found`）。
- 每次查看轨迹详情、评测用例详情都写审计 `trajectory.viewed`。评测数据不提供导出接口。企业管理员默认读不到对话。
- 延迟由事件 `created_at` 推出，不加事件字段（C2）：模型延迟 = 该步 `usage` − `model_call`，工具耗时 = `tool_result` −
  `tool_call_started`，审批等待 = `approval_decided` − `approval_requested`。成本读时按 PG `model_prices`（每百万 token，
  币种 = 部署设置 `priceCurrency`）计算，不写日志，界面标「估算」，无价格显示「—」。

## 测试

- 单元 / HTTP：`packages/kernel/test/evals/`（`reconstruct`、`step-replay`、`run-replay`、`runs`、`judge`、`diff`、`sets.*`、
  `trajectory.*`）。要确定的评委结论时，把 `eval` 用途映射到测试里的假模型插件（如 `m6-segment1.dual.test.ts` 的
  `judge-gate`）。
- 双副本：`runs.dual.test.ts`（组织并发 1 / 2、越限后 `capped` 与超出的上界）、`m6-segment1.dual.test.ts`（对话 → 轨迹 →
  评测集 → 单步回放中杀副本 → 整轮越限 → 标注）。
- 一律从仓库根跑 vitest（`pnpm exec vitest run <路径>`）：根配置带 `@capybara-hq/source` 条件，双副本测试按源码加载插件需要它。
