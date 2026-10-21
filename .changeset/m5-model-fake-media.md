---
"@capybara-hq/plugin-model-fake": minor
---

模型配置新增可选 `vision` / `documents`（缺省 false）；新增 `media:` 指令，回显最后一条 user 消息里的
媒体块（类型、mediaType、解码后的字节数、名称），供 e2e 核对模型收到的是媒体块而不是文字占位。
