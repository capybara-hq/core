---
"@capybara-hq/kernel": patch
---

M5 收尾的小修：

- `sandbox_deliver`：没有对象存储时报「工具不可用」（英文原因），调用时先核对存储再读沙箱。
- `model_call.request.media` 的 outcome 新增 `too_many_images`（单次请求图片超过 20 张）与 `too_large`（单个超过
  供应商上限），`omitted` 只表示因请求媒体预算省略。
- 只在最新的技能目录快照不为空时给模型 `skill_load`（技能被全部删除或取消选择后不再提供）。
- 删除 agent 后投递一次性任务 `sandbox-destroy-for` 销毁它各对话的沙箱（与成员离职同一路径，锁内、幂等）。
