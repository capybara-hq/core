---
"@capybara-hq/kernel": patch
---

M5 收尾的小修：

- `sandbox_deliver`：没有对象存储时报「工具不可用」（英文原因），调用时先核对存储再读沙箱。
- `model_call.request.media` 的 outcome 新增 `too_many_images`（单次请求图片超过 20 张）与 `too_large`（单个超过
  供应商上限），`omitted` 只表示因请求媒体预算省略。
