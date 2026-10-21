---
"@capybara-hq/plugin-sandbox-docker": minor
---

新插件 `@capybara-hq/plugin-sandbox-docker`（`sandbox@1`，M5 T9）：每个对话一个 Docker 容器（runc 或 gVisor
runsc），只经 socket 代理（`docker/sandbox-proxy` 的 HAProxy 配置，只放行用到的 Engine API）访问 Docker，不挂
`docker.sock`。部署配置 `endpoint`、`runtime`、`network`、`egressProxyImage`、`volumeDriver`。同名 `create`
先换掉旧实例；`destroyByName` 清容器、出站代理、内部网络与卷。非 root、`CapDrop: ALL`、`no-new-privileges`、
只读根文件系统、cpu / 内存 / 进程数限制；`/skills` 只读挂载（插件经 root 专用的可写挂载写技能）。`exec` 超时或
中止时按会话杀掉命令及其子进程。出站 `none` / `allowlist` / `open`：allowlist 经每个沙箱一个的出站代理（无依赖
Node），按主机名放行并拒绝解析到私有 / 回环 / 链路本地 / 元数据 / CGNAT / ULA 等地址的连接（挡 DNS 重绑定）。
沙箱镜像 `image/Dockerfile`（标签 `capybara-sandbox:latest`，与 `sandbox.image` 默认值一致，E2B 模板共用）。
开发编排加 `sandbox` profile。
