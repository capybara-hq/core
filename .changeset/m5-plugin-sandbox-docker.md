---
"@capybara-hq/plugin-sandbox-docker": minor
---

新插件 `@capybara-hq/plugin-sandbox-docker`（`sandbox@1`，M5 T9）：每个对话一个 Docker 容器（runc 或 gVisor
runsc），只经 socket 代理（`docker/sandbox-proxy` 的 HAProxy 配置，只放行用到的 Engine API）访问 Docker，不挂
`docker.sock`。部署配置 `endpoint`、`runtime`、`network`（须以 cap 开头）、`egressProxyImage`、`volumeDriver`、`allowOpenEgress`（默认 false）。socket 代理只放行 cap- 资源并按正则检查请求体，绝不能发布到宿主机地址。同名 `create`
先换掉旧实例；`destroyByName` 清容器、出站代理、内部网络与卷。非 root、`CapDrop: ALL`、`no-new-privileges`、
只读根文件系统、cpu / 内存 / 进程数限制；`/skills` 只读挂载（插件经 root 专用的可写挂载写技能）。`exec` 超时或
中止时按会话杀掉命令及其子进程，并经 `timeout -s KILL` 在沙箱里也有时限（内核副本崩溃时兜底）；`killAll` 杀掉前任
遗留的命令。容器被停了（宿主机 / 守护进程重启等）时 exec 与文件操作先自动启动再重试；容器主进程以 root（无能力）
运行，沙箱用户停不掉容器。socket 代理拒绝 `Source` 不以 `cap-` 开头的挂载，拉镜像只允许 `fromImage`。出站 `none` / `allowlist` / `open`：allowlist 经每个沙箱一个的出站代理（无依赖
Node），按主机名放行并拒绝解析到私有 / 回环 / 链路本地 / 元数据 / CGNAT / ULA 等地址的连接（挡 DNS 重绑定）。
沙箱镜像 `image/Dockerfile`（标签 `capybara-sandbox:latest`，与 `sandbox.image` 默认值一致，E2B 模板共用）。
开发编排加 `sandbox` profile。
