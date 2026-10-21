---
"@capybara-hq/plugin-sdk": minor
---

`sandbox@1`：新增 `SandboxGoneError` 与 `isSandboxGoneError`（实例确定不在时 `exec` / `readFile` / `writeFile` / `stat`
抛它，内核重建并重试一次）；`suspend` / `destroy` 在实例不存在时必须成功；新增可选方法
`destroyByName(name, signal)`，供内核清理没记下句柄的实例。
