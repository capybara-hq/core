---
"@capybara-hq/kernel": minor
---

工具审计链（spec 3.6 R6）：审计 `tool.called` 的 detail 记录完整链路——actor（运行发起人）→ `agentId` / `agentVersion` → `conversationId` / `runId` / `callId` / `toolKey`（应用工具带 `appId`）→ 放行依据：在审批下执行时为 `approvalId` / `approvedByAccountId` / `scope`，记住的授权放行时为 `grant: "session" | "always"`，策略本身放行时为 `policy: "allow"`；续跑时「结果未知」的调用只认已批准的审批，否则不记放行依据。不含参数、结果与凭据。执行时策略判定在授权把 `ask` 放行时返回 `{ grant }`（按 allow 执行）。

等待兜底扫描：维护队列每 10 分钟一次（job scheduler `wait-sweep-every-10m`，多副本只有一个）——过期仍 pending 的审批 / 输入请求按超时处理并续跑（防超时任务丢失）；waiting 超过 1 分钟、等待却已全部处理的运行（决定提交后崩溃、续跑投递回滚）重新续跑；运行已终态仍 pending 的审批 / 输入请求取消并写决定 / 回答事件。与超时任务、人工决定、其他副本的扫描并发时每项修复只生效一次，每项修复记一行 warn（只含 id）。
