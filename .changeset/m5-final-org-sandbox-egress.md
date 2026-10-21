---
"@capybara-hq/kernel": minor
---

组织级沙箱出站（Ruling M19，D6）：

- 组织设置新增 `sandboxEgress`（缺省跟随部署的 `sandbox.limits.egress` + `allowHosts`）：`{ mode: "none" }`，
  或 `{ mode: "allowlist", allowHosts? }`。`allowHosts` 给出时**替换**部署的白名单（可去掉预置项、也可加主机），
  省略时沿用部署的；每项经 `validateAllowHost`，最多 200 个、不能重复。没有 `open`；部署为 `none` 时只能设
  `none`（新错误码 `org.sandbox_egress_not_allowed`，400），部署后来改成 `none` 时存量设置也随之收紧。
  PATCH 传 `null` 清除。存量值非法时按 `none` 读。
- 设置的 GET / PATCH 响应带 `deployment.sandboxEgress`（部署默认值，设置页展示用）。
- `SandboxService` 创建沙箱时传组织实际生效的出站；只对之后新建的沙箱生效。
- 默认白名单加 `codeload.github.com`、`raw.githubusercontent.com`、`release-assets.githubusercontent.com`，
  去掉 `deb.debian.org`（沙箱用户没有 sudo，装不了 apt 包）。
