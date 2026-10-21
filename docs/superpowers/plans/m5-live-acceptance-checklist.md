# M5 真实环境验收清单（沙箱：Docker runsc / E2B；真实模型的图片 / PDF；技能）

M5 第二段验收（Task 12）分三部分：

1. **双副本验收**（自动，有 Docker 时 `pnpm test` 里跑，没有 Docker 时跳过）：
   `packages/kernel/test/sandbox/m5-segment2.dual.test.ts`——真实的 `sandbox-docker` 插件（runc、出站 none）、
   SeaweedFS 对象存储、两个内核子进程：上传附件 → `sandbox_bash` 处理 → `sandbox_deliver` 交付并下载 →
   杀掉执行运行的副本后另一个副本续跑、复用同一个容器 → 空闲休眠后恢复。本机约 70 秒（其中约 60 秒是等被杀副本
   持有的沙箱锁过期，锁 TTL 60 秒）。
2. **真实运行时自动检查**（有 runsc / E2B 凭据时跑，本清单第 2、3 节）。
3. **人工检查**（本清单第 4 节）：网页上的附件、产物标签与沙箱状态。

第一段（附件与媒体输入）与第三段（技能）的真实环境部分在第 5、6 节：带图片 / PDF 的真实模型请求，以及网页上的技能库、
技能变更审批与技能脚本。第三段的双副本验收 `packages/kernel/test/skills/m5-segment3.dual.test.ts`（假沙箱，`pnpm test`
里跑，约 10 秒）覆盖共享 agent 的 `skill_write` → 跨副本批准 → 另一对话下次运行生效、`skill_load` 复制脚本进沙箱并执行。

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

### 2.4 CI 上的 linux/amd64 Docker

本机验收在 arm64 的 Docker Desktop 上跑；amd64 镜像（Debian 包、GNU `timeout` / `pgrep -P` / `pkill -s` 的行为）
与 Linux 原生守护进程（网络、`restart`、卷）要在 CI 上再确认一次：

- [ ] CI 的 linux/amd64 runner（原生 Docker Engine，不是 Docker Desktop）上 `pnpm vitest run plugins/sandbox-docker`
      全部通过（含 socket 代理的真实 HAProxy 用例、「stopped behind the kernel's back」、「commands left behind by a
      crashed kernel replica」），没有 skipped（除 runsc）；
- [ ] 同一 runner 上 `pnpm vitest run packages/kernel/test/sandbox/m5-segment2.dual.test.ts` 通过（接手时杀掉前任留下的
      `sleep 300`，输出 `leftover=0`）；
- [ ] `docker buildx build --platform linux/amd64 plugins/sandbox-docker/image` 成功，镜像里 `timeout --version` 是
      GNU coreutils。

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

## 5. 真实模型：带图片 / PDF 的请求

凭据同样放在 `~/.capybara-test.env`（`CAPYBARA_TEST_ANTHROPIC_API_KEY`、`CAPYBARA_TEST_OPENAI_API_KEY` +
`CAPYBARA_TEST_OPENAI_MODEL`、`CAPYBARA_TEST_OAICOMPAT_*`），只注入环境，不打印。

### 5.1 一致性套件的媒体用例

```bash
set -a; . ~/.capybara-test.env; set +a
pnpm vitest run plugins/anthropic/test/conformance.test.ts plugins/openai/test/conformance.test.ts
# 方舟（ark）：CAPYBARA_TEST_OAICOMPAT_DIALECT=ark，模型支持图片时加 CAPYBARA_TEST_OAICOMPAT_VISION=1
pnpm vitest run plugins/openai-compatible/test/conformance.test.ts
```

- [ ] anthropic、openai 的「user message with image」「user message with PDF document」「user message with text document」
      通过（不是 skipped）；
- [ ] **ark 方言的图片用例**通过（尚未用真实接口验证过；ark 不收 PDF，`documents` 由配置校验拒绝）；
- [ ] 换用新模型时先核对它的 `vision` / `documents` 声明（anthropic 取 Models API；openai / openai-compatible 由配置给）。

### 5.2 内核 + 网页（人工）

按第 4 节起内核与网页，`CAPYBARA_PLUGINS` 换成真实模型插件（如 `@capybara-hq/plugin-anthropic`）加 `object-store-s3`。

- [ ] 上传一张 PNG，问「图里是什么颜色」：回答正确；`model_call` 事件的 `request.media` 里该附件 `outcome` 为 `bytes`；
- [ ] 上传一页 PDF，问其中的一个词：回答正确；
- [ ] 换一个不支持图片的模型（如 openai-compatible 未开 `vision`）再发图片：模型只收到英文占位 `[Attached image "<名字>" — this model cannot view images.]`、照常回答，
      `request.media` 为 `placeholder_unsupported`，供应商请求里没有图片字节；
- [ ] 一条消息带 10 个附件、总量超过 `attachments.requestMediaBytes`：较早的换成占位，请求不被供应商拒收。

## 6. 技能（人工）

按第 4 节起内核与网页（对象存储 + `sandbox-docker`）。准备一个 zip：根下 `SKILL.md`（frontmatter 带 `name: fruit-sum`、
`description`）与 `run.sh`（`echo fruit-sum ok`）。

- [ ] **技能库**：管理员在顶栏「技能」上传 zip，列表出现 `fruit-sum v1`；详情页 SKILL.md 按纯文本显示；成员能看、看不到上传与删除；
      再传一次同名包得到 v2；超过 50MB 或缺 `SKILL.md` 的包被拒并逐条列出原因。
- [ ] **agent 用技能**：编辑 agent，在「技能」里勾选 `fruit-sum`，工具加 `sandbox_bash`；对话里
      `tool:skill_load:{"name":"fruit-sum"}` 返回正文，再 `tool:sandbox_bash:{"command":"sh /skills/fruit-sum/run.sh"}`
      输出 `fruit-sum ok`；`touch /skills/x` 失败（只读）。
- [ ] **共享 agent 改技能**：共享（组织可见）agent 加 `skill_write`，由另一个成员在对话里让它写技能：先出现工具确认（R3），
      确认后负责人的收件箱出现「技能变更」，能看到逐文件差异；批准前别的对话 `skill_load` 看不到，批准后别的对话下一次运行
      收到更新提醒并加载到新版本；拒绝时发起对话回到旧版本。
- [ ] **私有 agent 改技能**：直接生效，不进收件箱；负责人在 agent 编辑页能删除 agent 自写的技能。

## 7. 执行记录

| 日期 | 执行人 | 部分 | 结果 / 备注 |
|---|---|---|---|
| 2026-10-21 | 自动 | 双副本验收（runc，arm64 Docker Desktop） | 通过 3/3，每次约 70 秒（续跑接手约 1.2 秒，复用沙箱等锁约 60 秒） |
| | | runsc（第 2 节） | 待 Linux 主机执行 |
| | | CI linux/amd64 Docker（2.4） | 待 CI 执行 |
| | | E2B（第 3 节，含 14 条假设） | 待凭据到位后执行 |
| | | 人工（第 4 节） | 待执行 |
| 2026-10-21 | 自动 | 第三段双副本验收（假沙箱） | 通过 3/3，每次约 10 秒 |
| 2026-10-21 | 协调者 | 真实模型媒体（5.1：anthropic `claude-haiku-5-5`、openai `gpt-5-nano`） | 图片、PDF、文本文档通过 |
| | | ark 方言图片（5.1） | 待凭据 |
| | | 内核 + 真实模型媒体（5.2） | 待执行 |
| | | 技能（第 6 节） | 待执行 |
