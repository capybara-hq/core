---
"@capybara-hq/plugin-model-fake": minor
---

新增脚本指令 `slowfail:<ms>:<text>`：按块流式输出文本后报不可重试的错误（不产生 message_complete），用于测试流式中途失败。
