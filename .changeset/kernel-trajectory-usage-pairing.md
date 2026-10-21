---
"@capybara-hq/kernel": patch
---

轨迹：步骤被重新发起时，`usage` 与 `assistant_message` 按该步最后一次 `model_call` 之后的第一条配对
（此前取该步第一条，延迟与用量可能配到较早的尝试上）。
