---
"@capybara-hq/kernel": minor
---

私有 agent 的 `skill_write` 确认开关：agent 定义新增 `skills.writePolicy`（`allow` / `ask`，缺省 allow）。私有 agent 设为
`ask` 时 `skill_write` 按固定询问（记住的授权无效），确认后直接生效；共享 agent 不论取值都走 R3 + R4。执行时读 agent
当前版本，运行中改动下一次调用即生效。
