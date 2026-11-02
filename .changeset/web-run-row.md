---
"@capybara-hq/web": patch
---

Every run in a conversation ends with a run row: `运行 · <model> · <duration> · <tokens>` and its
status mark, built from the event log alone. A finished run's row is one quiet collapsed line; a
failed run's row opens on the error (a sentence in the reader's language, the raw kernel text
behind 原始错误), Retry, 查看轨迹 for the roles that may read the trajectory and, for enterprise
admins when the model service is misconfigured, 去配置模型服务. It replaces the stopped, failed and
hook-denied dividers. The properties panel's Context section shows the last run.
