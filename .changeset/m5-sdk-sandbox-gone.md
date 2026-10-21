---
"@capybara-hq/plugin-sdk": minor
---

`sandbox@1`：新增 `SandboxGoneError` 与 `isSandboxGoneError`（实例确定不在时 `exec` / `readFile` / `writeFile` / `stat`
抛它，内核重建并重试一次）；`suspend` / `destroy` 在实例不存在时必须成功；新增可选方法
`destroyByName(name, signal)`，供内核清理没记下句柄的实例。

契约写明：提供方的每个方法都必须及时响应 `signal`；`exec` 被中止时必须杀掉正在跑的命令。

契约另写明（fix wave S2）：实例还在、只是被停了 / 暂停了时，`exec` / `readFile` / `writeFile` / `stat` 必须先透明地
启动它（自动启动）；`exec` 的时限在沙箱里也要生效（内核副本崩溃后命令不能无限期地跑下去）；`maxOutputBytes` 是
stdout 与 stderr 合计；`readFile` 遇到目录返回 null。新增可选方法 `killAll(h, signal)`：杀掉经 `exec` 启动、仍在
运行的全部命令，内核接手崩溃的前任持锁方时调用。
