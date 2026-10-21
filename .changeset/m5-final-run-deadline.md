---
"@capybara-hq/kernel": minor
---

运行时限与沙箱命令（Ruling M20）：

- 内置工具的上下文新增 `runDeadline`（运行截止时间）。`sandbox_bash` 的命令超时收紧到运行剩下的时间减 30 秒余量
  （拿到沙箱后再算，等锁与恢复的时间一并扣掉）；收紧时结果说明 `This run's time budget limits commands to N seconds
  (configurable via runtime.maxRunSeconds)`，命令赶在截止前自己超时，而不是被运行截止打断成「结果未知」。
- `sandbox_glob` / `sandbox_grep` 的命令超时也受运行截止约束。
- 有沙箱提供方且 `runtime.maxRunSeconds < sandbox.limits.maxCommandSeconds`时启动记日志（两项都是默认值 900 < 7200 时为 info，运维改过一项仍不一致时为 warn）；
  两个配置项的说明写明长命令需要 `maxRunSeconds ≥ maxCommandSeconds`。
