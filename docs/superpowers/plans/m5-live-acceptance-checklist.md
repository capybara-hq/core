# M5 真实环境验收清单（沙箱：Docker runsc / E2B）

M5 第二段验收（Task 12）分三部分：

1. **双副本验收**（自动，有 Docker 时 `pnpm test` 里跑，没有 Docker 时跳过）：
   `packages/kernel/test/sandbox/m5-segment2.dual.test.ts`——真实的 `sandbox-docker` 插件（runc、出站 none）、
   SeaweedFS 对象存储、两个内核子进程：上传附件 → `sandbox_bash` 处理 → `sandbox_deliver` 交付并下载 →
   杀掉执行运行的副本后另一个副本续跑、复用同一个容器 → 空闲休眠后恢复。本机约 70 秒（其中约 60 秒是等被杀副本
   持有的沙箱锁过期，锁 TTL 60 秒）。
2. **真实运行时自动检查**（有 runsc / E2B 凭据时跑，本清单第 2、3 节）。
3. **人工检查**（本清单第 4 节）：网页上的附件、产物标签与沙箱状态。

插件细节见 `plugins/sandbox-docker/README.md`、`plugins/sandbox-e2b/README.md`，这里不重复。

---

## 0. 先读：socket 代理放在哪里

`sandbox-docker` 插件只经 `docker/sandbox-proxy` 的 HAProxy socket 代理访问 Docker。**能访问代理就几乎能控制
Docker**（代理的请求体检查只是正则兜底）。

- **绝不要把代理发布到宿主机的任何地址上，包括 `127.0.0.1`**：Docker Desktop 上普通 bridge 网络里的容器经
  `host.docker.internal` 就能访问宿主机回环；Linux 上网桥网关地址也能到达宿主机监听的端口。
- 生产环境只把它放在内核所在的内部网络上（`endpoint` 填 `tcp://sandbox-proxy:2375`），不映射端口，沙箱容器不接那个网络。
- 开发编排（`docker compose -f docker/compose.dev.yaml --profile sandbox up -d`）为了让本机内核连上，发布在
  `127.0.0.1:2375`：只在本机开发用，并且**不要打开 `allowOpenEgress`**（open 出站的沙箱能访问宿主机回环，也就能访问代理）。
- 验收时检查：`docker port <代理容器>` 在生产编排里应为空；沙箱容器 `docker inspect cap-<对话 id>` 的
  `NetworkSettings.Networks` 里没有内核 / 代理所在的网络。

## 1. 凭据与环境变量

凭据放在 `~/.capybara-test.env`，由外层 shell 注入环境（测试代码不读这个文件），**任何时候都不要打印或贴出值**。
值以「替换为」开头视为未填。

| 变量 | 必填 | 说明 |
|---|---|---|
| `CAPYBARA_TEST_E2B_API_KEY` | E2B 必填 | E2B API key（`e2b_…`） |
| `CAPYBARA_TEST_E2B_TEMPLATE` | E2B 必填 | 由 `plugins/sandbox-docker/image/Dockerfile` 构建的模板名或 id（见 3.1） |
| `CAPYBARA_TEST_E2B_API_URL` | 可选 | 自托管 E2B 的控制面地址 |
| `CAPYBARA_TEST_E2B_DOMAIN` | 可选 | 自托管 E2B 的沙箱域名（默认 `e2b.app`） |

runsc 不需要凭据，只要 Docker 守护进程登记了 `runsc` 运行时（第 2 节）。

## 2. Docker + gVisor（runsc）

### 2.1 安装与登记（Linux 主机；Docker Desktop 不支持自定义运行时）

```bash
# 按 https://gvisor.dev/docs/user_guide/install/ 安装 runsc（apt 源或直接下载二进制）
sudo runsc install                # 往 /etc/docker/daemon.json 写入 "runtimes": {"runsc": {"path": "/usr/local/bin/runsc"}}
sudo systemctl restart docker
docker info --format '{{json .Runtimes}}'     # 应含 "runsc"
docker run --rm --runtime=runsc hello-world   # 能跑通
```

- 需要限制工作区磁盘（`sandbox.limits.diskMb`）时，`volumeDriver` 要选支持 `size` 选项的卷驱动；local 驱动不限大小。
- arm64 主机：gVisor 有 arm64 构建，步骤相同。

### 2.2 自动检查

```bash
docker build -t capybara-sandbox:latest plugins/sandbox-docker/image
pnpm vitest run plugins/sandbox-docker/test/sandbox-docker.test.ts -t runsc
```

预期：用例「runsc: lifecycle under gVisor」**通过而不是 skipped**（skipped 说明 `docker info` 里没有 runsc）：
容器 `HostConfig.Runtime` 为 `runsc`，写读文件、执行命令、休眠 / 恢复后文件仍在、销毁后 gone。

### 2.3 内核 + runsc 冒烟（人工）

按第 4 节起内核，插件配置里加 `"runtime":"runsc"`：

```bash
export CAPYBARA_PLUGIN_CONFIG='{"object-store-s3":{…},"sandbox-docker":{"endpoint":"tcp://127.0.0.1:2375","runtime":"runsc"}}'
```

- [ ] 对话里让 agent 跑 `sandbox_bash`：`uname -a; dmesg | head -3` 的输出里能看到 gVisor（`Starting gVisor...`）；
- [ ] `docker inspect cap-<对话 id> --format '{{.HostConfig.Runtime}}'` 为 `runsc`；
- [ ] `sandbox_bash` 跑 `sleep 600`、`timeoutSeconds: 2`：约 2 秒后返回 timedOut，随后 `ps -eo args` 里没有 `sleep 600`；
- [ ] 第 4 节的附件、交付、休眠 / 恢复流程在 runsc 下同样走通。

## 3. E2B

### 3.1 构建模板（与 Docker 插件同一份 Dockerfile）

用 E2B 的 Template SDK（或 e2b CLI）从 `plugins/sandbox-docker/image/Dockerfile` 构建，步骤见
`plugins/sandbox-e2b/README.md`「模板」一节（`Template().fromDockerfile(...)`、`cpuCount: 1`、`memoryMB: 2048`，
模板名如 `capybara-sandbox`）。改了 Dockerfile 要重新构建模板。构建后把模板名填进 `CAPYBARA_TEST_E2B_TEMPLATE`。

### 3.2 自动检查

```bash
set -a; . ~/.capybara-test.env; set +a     # 只注入环境，不要 cat / echo
pnpm vitest run plugins/sandbox-e2b/test/live
```

预期：全部通过（变量没填齐时整组 skipped，并打印 `[e2b-live] skipped`）。覆盖沙箱用户与工作目录、文件读写、
`/skills` 只读、出站白名单、输出截断、超时杀进程、中止、长时间无输出保活、重启兜底、同名替换、暂停 / 恢复后
文件仍在、销毁后 gone。

**第一次跑时**逐条核对 `plugins/sandbox-e2b/test/live/sandbox-e2b.live.test.ts` 文件头的 14 条「只能在真实 E2B 上
确认的假设」（`sandbox` 用户与 envd Basic 认证、`/opt/capybara` 与 `/skills` 的属主权限、runuser / setsid / pkill、
root 上传、`envdAccessToken`、connect 的 200 / 201 与 `memory: false` 冷启动、暂停后 envd 回 502、长流保活、
`autoPause`、allowlist 请求体与 `*.` 通配、列表接口的 metadata 过滤与分页、SendSignal 的 404、pause 409 / DELETE 404
的格式），把结果记进本清单的执行记录。失败时先对照这 14 条找是哪条假设不成立。

### 3.3 内核 + E2B 冒烟（人工）

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake","@capybara-hq/plugin-object-store-s3","@capybara-hq/plugin-sandbox-e2b"]'
export CAPYBARA_PLUGIN_CONFIG="{\"object-store-s3\":{…},\"sandbox-e2b\":{\"apiKey\":\"$CAPYBARA_TEST_E2B_API_KEY\",\"template\":\"$CAPYBARA_TEST_E2B_TEMPLATE\"}}"
```

- [ ] 第 4 节的流程走通；E2B 控制台里每个对话一个沙箱，metadata `capybara-sandbox-name=cap-<对话 id>`；
- [ ] 休眠后控制台里状态为 paused，再用时恢复（running），文件仍在；
- [ ] `sandbox.limits.egress` 为 `allowlist` 时 `curl -sI https://pypi.org` 通、`curl -sI https://example.com` 不通；
      README「出站」一节列出的局限（只看 Host / SNI）已告知部署方；
- [ ] 删除对话后（或等销毁任务）控制台里的沙箱被删掉。

## 4. 人工检查：本地起一套内核 + 网页

```bash
docker compose -f docker/compose.dev.yaml up -d                     # postgres、valkey、seaweedfs（建好桶 capybara）
docker compose -f docker/compose.dev.yaml --profile sandbox up -d   # socket 代理 127.0.0.1:2375 + 两个镜像
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake","@capybara-hq/plugin-object-store-s3","@capybara-hq/plugin-sandbox-docker"]'
export CAPYBARA_PLUGIN_CONFIG='{"object-store-s3":{"endpoint":"http://localhost:8333","region":"us-east-1","bucket":"capybara","accessKeyId":"capybara","secretAccessKey":"capybara-secret","forcePathStyle":true},"sandbox-docker":{"endpoint":"tcp://127.0.0.1:2375"}}'
export CAPYBARA_PLUGIN_PERMISSIONS__AUTO_APPROVE=true        # 只用于本地试用
export CAPYBARA_AUTH__COOKIE_SECURE=false
export CAPYBARA_SANDBOX__LIMITS__SUSPEND_AFTER_IDLE_MINUTES=1   # 便于观察休眠
pnpm capybara migrate
pnpm capybara start            # 内核 :8080
pnpm dev:web                   # 另一个终端，网页 :3000
```

浏览器打开 `http://localhost:3000`，新建 agent：模型 `model-fake/fake-1`（或真实模型），工具加内置的
`sandbox_bash`、`sandbox_read`、`sandbox_write`、`sandbox_deliver`。

- [ ] **附件**：对话里上传一个 CSV（≤ 20MB），发 `echo:here`；消息下显示附件。再发
      `tool:sandbox_bash:{"command":"ls -l /workspace/attachments && wc -l /workspace/attachments/*.csv"}`：
      结果第一段是「Sandbox started for this conversation (first use)…」，能看到文件。
- [ ] **沙箱状态**：右侧「沙箱」标签显示「运行中」与最近使用时间；`docker ps` 里有 `cap-<对话 id>`。
- [ ] **交付**：`tool:sandbox_bash:{"command":"mkdir -p out && sort /workspace/attachments/*.csv > out/sorted.csv"}`，
      再 `tool:sandbox_deliver:{"path":"/workspace/out/sorted.csv"}`；「产物」标签出现 `sorted.csv`（类型、大小、时间），
      预览显示开头几行，「下载」得到同样的内容（浏览器下载，文件名正确）。
- [ ] **休眠 / 恢复**：空闲 1–2 分钟后「沙箱」标签变为「已休眠」，`docker ps` 里容器已停止（`docker ps -a` 仍在）；
      再发一次 `sandbox_read` 读 `/workspace/out/sorted.csv`：内容还在，结果里**没有** started / recreated 提示，
      标签回到「运行中」。
- [ ] **出站**：默认 `allowlist` 下 `curl -sI https://pypi.org` 通、`curl -sI https://example.com` 失败（出站代理对 CONNECT 回 403）。
- [ ] **重建**：`docker rm -f cap-<对话 id>` 后再用沙箱：结果带「Sandbox was recreated; previous files are gone.」，
      运行不报错卡住。

## 5. 执行记录

| 日期 | 执行人 | 部分 | 结果 / 备注 |
|---|---|---|---|
| 2026-10-21 | 自动 | 双副本验收（runc，arm64 Docker Desktop） | 通过 3/3，每次约 70 秒（续跑接手约 1.2 秒，复用沙箱等锁约 60 秒） |
| | | runsc（第 2 节） | 待 Linux 主机执行 |
| | | E2B（第 3 节，含 14 条假设） | 待凭据到位后执行 |
| | | 人工（第 4 节） | 待执行 |
