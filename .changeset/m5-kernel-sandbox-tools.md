---
"@capybara-hq/kernel": minor
---

沙箱内置工具与产物交付（M5 T8）：

- 新内置工具 `sandbox_bash` / `sandbox_read` / `sandbox_write` / `sandbox_edit` / `sandbox_glob` /
  `sandbox_grep` / `sandbox_deliver`（Ruling M12：key 不能含 `.`），agent 按 `{kind:"builtin", name}` 引用。
  都在本对话的沙箱上执行，执行前把本对话的附件复制到 `/workspace/attachments/<name>`（标记文件避免重复，
  新建 / 重建的沙箱重新复制）。首次使用、重建后在结果开头加英文说明。没有沙箱提供方时报「工具不可用」。
- `sandbox_bash`：`timeoutSeconds` 默认 120、不超过 `sandbox.limits.maxCommandSeconds`；超时停掉命令并返回
  `timedOut`，沙箱仍可用；结果超过 30000 字符走输出存档。工具描述写明休眠后后台进程可能结束、`/tmp` 可能清空。
- 沙箱工具的执行时限 = `tools.timeoutMs` + 等锁（`sandbox.lockWaitSeconds`）+ 3 分钟余量（创建 / 恢复与 E2B 重启
  兜底）；`sandbox_glob` / `sandbox_grep` 的命令超时按本次调用剩下的时间算，等锁用掉的时间从中扣除。
- `sandbox_deliver`：文件上限新配置 `sandbox.deliverMaxBytes`（默认 100 MB），存到
  `kernel/<org>/artifacts/<对话>/<产物 id>`，写新事件 `artifact_created`；
  新接口 `GET /api/v1/orgs/:orgId/conversations/:id/artifacts/:artifactId/download`（访问规则同会话流，
  302 到预签名地址，一律 `attachment`），新错误码 `conversation.artifact_not_found`（404）。
- 组织设置新增 `sandboxToolPolicy`（`allow` / `ask`，默认 allow）：为 ask 时除 read / glob / grep 外需要审批。
- `BuiltinTool` 可选 `timeoutMs(input)`（覆盖 `tools.timeoutMs`）、`spillChars`（更低的转存阈值）、
  `unavailable()`（本部署不可用的原因）；内置工具的上下文带 `runId`。
