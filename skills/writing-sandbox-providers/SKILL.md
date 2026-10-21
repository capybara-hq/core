---
name: writing-sandbox-providers
description: 新建或修改沙箱插件时使用（provides sandbox@1，如 plugins/sandbox-docker、plugins/sandbox-e2b）：契约原语与中止语义、SandboxGoneError 与普通错误的区别、已停止实例的自动启动、沙箱内命令时限、killAll（接手崩溃前任 / 从休眠恢复）、同名实例替换与 destroyByName、/skills 只读、出站 none / allowlist / open 与 allowOpenEgress、限制只在创建时生效；SandboxService 的生命周期（Redis 锁 TTL 与续租、lockWaitSeconds、防护号、空闲休眠、maxRunning、不活跃销毁、重建与提示）；安全（socket 代理放哪里、出站代理按解析后的 IP 挡 DNS 重绑定）；以及用假沙箱插件、真实 Docker 与 startFakeE2B / 真实 E2B 写测试。
---

# 写沙箱插件

每个对话一个沙箱（D4），内核的沙箱工具（`sandbox_bash` / `read` / `write` / `edit` / `glob` / `grep` / `deliver`）、
附件同步与 `skill_load` 都经 `SandboxService` 用它。`sandbox@1` 是**单选、中转**能力：一个部署只装一个沙箱插件，
别的插件不能 `requires` 它。通用插件写法见 `skills/writing-plugins`，工具这一侧见 `skills/writing-tools`。

参考实现：

- `plugins/sandbox-docker`：每个对话一个容器（runc 或 gVisor 的 runsc），只经 socket 代理访问 Docker，出站白名单由每个沙箱自带的代理容器执行。
- `plugins/sandbox-e2b`：E2B 云或自托管，休眠用 pause、恢复用 connect，自写极简客户端（不用官方 SDK：它读进程环境变量、有模块级连接池）。
- `packages/kernel/test/fixtures/plugins/sandbox-fake`：最小形状（本机目录 + `/bin/sh`，**没有隔离，只供测试**），先读它再读真实插件。

两个插件的 README 逐条写了平台出处、每个取舍和已知局限，写新实现时照这个粒度写。

## 契约：`sandbox@1`（`packages/plugin-sdk/src/sandbox.ts`）

```ts
interface SandboxProvider {
  create({ name, image, limits, signal }): Promise<SandboxHandle>;  // name = cap-<conversationId>
  resume(h, signal): Promise<"resumed" | "gone">;
  suspend(h, signal): Promise<void>;          // 文件必须保留；实例不在也算成功
  destroy(h, signal): Promise<void>;          // 不在也算成功
  destroyByName?(name, signal): Promise<void>;
  killAll?(h, signal): Promise<void>;
  exec(h, { command, cwd?, env?, timeoutMs, maxOutputBytes, signal }): Promise<ExecResult>;
  readFile(h, path, { maxBytes, signal }): Promise<{ data; truncated } | null>;  // 不存在或是目录 → null
  writeFile(h, path, data, signal): Promise<void>;                               // 父目录自动创建
  stat(h, path, signal): Promise<{ size; isDir } | null>;
}
```

`glob` / `grep` / `edit` 由内核用 `exec` + `readFile` / `writeFile` 组合，提供方不实现。所以镜像里要有 GNU `find`
（`-print0`）与 `grep`（`-rnHIE`、`--include`）、`timeout`、`setsid`、`pkill` / `pgrep`。

### 必须遵守的语义

- **中止**：每个方法都及时响应 `signal`。调用时已中止 → 立即 reject；进行中被中止 → 尽快以中止原因结束。
  内核在锁丢失、运行被中止或超时时靠它停下，不响应就可能与新的持锁方同时操作同一实例。
  **`exec` 被中止要杀掉命令及其派生进程**，不只是不再等输出；命令启动后才被中止的 `exec` 以
  `{ exitCode: null, timedOut: false }` 正常 resolve（带已收集的输出），不 reject。超时 resolve `timedOut: true, exitCode: null`。
- **gone 与普通错误**：实例在提供方那边**确定**不在了（容器被删、E2B 沙箱过期）时，`exec` / `readFile` /
  `writeFile` / `stat` / `killAll` 抛 `SandboxGoneError`，`resume` 返回 `"gone"`。内核据此重建空沙箱并重试一次，
  模型看到 `Sandbox was recreated; previous files are gone.`。只是暂时连不上（401、5xx、网络错误、代理返回的裸 404）
  抛**普通错误**，否则一次网络抖动就把用户的文件清空了。判断用 `isSandboxGoneError`（鸭子类型，兼容插件自带一份 SDK）。
  E2B 只把 E2B 格式的 404（`{code: 404, …}`）当 gone；拿不到 envd 访问令牌也按 gone 报（宁可重建，也不发不带令牌的请求）。
- **自动启动**：实例还在但已停止 / 暂停（宿主机或守护进程重启、休眠扫描停了它却没来得及记下 `suspended`、有人
  `docker pause`）时，`exec` / `readFile` / `writeFile` / `stat` / `killAll` 先按 `resume` 的做法把它启动起来再执行，
  不报错。内核只信自己记的 `running`。
- **沙箱里的命令时限**：除了在提供方这边按 `timeoutMs` 停掉命令，命令本身要在沙箱里经
  `timeout -s KILL <timeoutMs + 几秒>` 运行。内核副本崩溃时提供方这边的计时随之消失，断开连接也不结束命令，
  靠这道时限保证它不会无限期地与下一个持锁方的命令并行。
- **killAll**：杀掉经 `exec` 启动、仍在运行的全部命令（按进程组与会话 SIGKILL），另起会话放到后台的进程不保证。
  内核在两种时候调用：拿到锁时发现前任持锁方没正常结束（Redis 标记 `capk:sandbox-busy:<对话>` 还在，即接手崩溃的
  副本），以及刚从 `suspended` 恢复时（E2B 暂停会连进程一起保留）。杀进程的 exec 本身起不来（进程数耗尽）时，
  Docker 退而 `restart?t=0`，E2B 退而 pause + `connect {memory: false}` 冷启动；这两种都只打 warn，调用照常返回。
- **同名替换**：`create` 先删掉同名的旧实例再建（内核可能在提供方建好、自己记下句柄之前退出）。同理实现
  `destroyByName`：内核拿不到句柄时按 `cap-<对话>` 清理（对话删除、测试清理）。
- **输出**：`maxOutputBytes` 是 stdout + stderr **合计**的上限，超出丢弃并置 `truncated`；截断时退回完整的 UTF-8 字符边界。
- **`/skills` 只读**：对沙箱用户只读挂载（或归 root 0755），`writeFile("/skills/…")` 由提供方以 root 写入，
  且不能被沙箱用户放的符号链接引到别处。内核的 `/skills` 写保护只按路径字符串判断，可被符号链接绕过，真正的
  防线在提供方。技能文件没有可执行位，`skill_load` 告诉模型用解释器运行（`sh /skills/x/run.sh`）。
- **文件操作以沙箱用户解析**：权限与符号链接按非 root 用户解析（Docker 在容器里跑 `head` / `stat` 小脚本；E2B 的
  上传接口以 root 打开目标，所以先传到 root 专用的中转目录，再 `runuser -u sandbox` 写目标）。不要经守护进程以 root 写卷。
- 路径都已经过 `validateSandboxPath`（只认 `/workspace`、`/skills`、`/tmp`），工作目录 `/workspace`，附件在
  `/workspace/attachments/`。

### 限制与出站（`SandboxLimits`）

- `egress` / `allowHosts` 是**组织实际生效**的值：组织设置 `sandboxEgress` 可把白名单换成自己的一份或断网，
  不能比部署更开（Ruling M19，内核 `effectiveSandboxEgress`）。提供方只管照 `create` 收到的执行，不读组织设置。
- `cpu` / `memoryMb` / `diskMb` / `egress` / `allowHosts` **只在 `create` 时生效**：改配置只影响之后新建的沙箱，
  已有的（含休眠后恢复的）沿用创建时的设置，直到被销毁重建。做不到某项时在 README 里写明（Docker 默认 local 卷驱动
  不限 `diskMb`；E2B 的 cpu / 内存 / 磁盘由模板决定）。
- `egress`：
  - `none`：只有回环。
  - `allowlist`（默认）：只放行 `allowHosts`（`validateAllowHost` 已挡掉 IP 字面量、单段名、`.local` / `.internal`；
    `*.example.com` 匹配子域、不含本身）。
  - `open`：提供方部署配置 `allowOpenEgress` 默认 false，为 false 时 `create` 收到 open 直接报英文错误。新插件照此实现。
- **白名单不防数据外传**：它挡内网与白名单外的主机，挡不住发往白名单主机的数据（`git push` 到 github.com、发包）。
  README 要写明这一点，并建议敏感组织用 `sandboxToolPolicy: ask` 和 / 或 `sandboxEgress: none`。
- 提供方做不到按域名放行时**拒绝或退化为 `none` 并打告警**，不能悄悄放开（E2B 自托管 `domainAllowlist: false`）。
  做得到但更弱的写进 README（E2B 只看 Host / SNI、不核对目的 IP，Ruling M14）。

## 生命周期：`SandboxService`（`packages/kernel/src/sandbox/sandbox.service.ts`）

内核负责，插件只实现原语，**不要在插件里做调度、计时或状态表**：

- **状态**在 PG 表 `sandboxes`（status `creating` / `running` / `suspended` / `destroyed`、handle、所属提供方），
  懒创建：第一次沙箱工具调用才 `create`。
- **串行**：同一对话的一切操作在 Redis 锁 `capk:sandbox:<对话>` 下，TTL 60 秒（`SANDBOX_LOCK_TTL_MS`），持有期间每
  TTL/3 续租；超过 TTL 没有成功续租视为丢锁，中止传给提供方的 signal。并发调用排队，最多等 `sandbox.lockWaitSeconds`
  （默认 75，**须大于锁 TTL**，否则副本崩溃后的第一次调用会先报 `sandbox.busy`，Ruling M15）。两个副本同时首次使用只建一个。
- **防护号**：每次拿锁先把 `generation` 加一，之后的状态写入按它比较，旧持锁方的写入必然失败（`SandboxLockLostError`）。
- **休眠**：维护任务每分钟扫描，空闲超过 `suspendAfterIdleMinutes`（默认 10），或连续运行超过 `maxRunningMinutes`
  （默认 120，Ruling M1）的调 `suspend`。正在执行命令（锁被持有）的跳过，下次再说。
- **销毁**：每小时扫描，不活跃超过 `destroyAfterInactiveDays`（默认 7）、组织已删除、对话已删除的调 `destroy`；
  成员离职经一次性任务 `sandbox-destroy-for` 立即销毁。
- **透明恢复**：休眠的下次使用时 `resume`；`gone`、已销毁、或记录的提供方不是当前提供方时重建空沙箱，工具结果带
  英文提示。换提供方会泄漏旧实例（新提供方销毁不了，记在 `prev_*` 列，旧插件仍加载时才清理）。
- **单条命令**上限 `sandbox.limits.maxCommandSeconds`（默认 7200）；`sandbox_bash` 默认 120 秒。命令超时还会收紧到
  所属运行剩下的时间减 30 秒（`runtime.maxRunSeconds`，默认 900，Ruling M20；内置工具上下文的 `runDeadline`），结果
  告诉模型是运行时限所致。长命令需要 `maxRunSeconds ≥ maxCommandSeconds`，否则启动打 warn。

## 安全

- **Docker 的 socket 代理**（`docker/sandbox-proxy/haproxy.cfg`）：只放行插件用到的接口，容器 / 卷只认 `cap-` 开头的名字，
  请求体按正则拒绝特权、`Binds`、`CapAdd`、非 ASCII 键（Go 按 Unicode 折叠键名，`Bindſ` = `Binds`）等。**这只是兜底，
  主要防线是网络位置**：能访问代理就几乎能控制 Docker。**绝不要把代理发布到宿主机的任何地址上（包括 127.0.0.1）**；
  生产只放在内核所在的内部网络，沙箱不接那个网络。开发编排发布在 `127.0.0.1:2375` 只供本机（Ruling M13），此时不要开
  `allowOpenEgress`（open 的沙箱能经 `host.docker.internal` 访问宿主机回环）。插件只经 `endpoint` 访问 Docker，不挂 `docker.sock`。
- **容器加固**：非 root（uid 1000）执行命令，PID 1 以 root 运行但 `CapDrop: ALL`（沙箱用户停不掉容器，Ruling M16），
  `no-new-privileges`、根文件系统只读、`PidsLimit`、私有 IPC，`/tmp` 是 tmpfs。
- **出站代理挡 DNS 重绑定**：只看主机名挡不住 `10.0.0.1.nip.io`。代理先解析，**解析出的每个 IP** 都不能是私有、
  回环、链路本地（含 169.254.169.254）、CGNAT、ULA、组播、保留地址（IPv4 映射 / NAT64 / 6to4 按内嵌 IPv4 判断），
  然后直连检查过的那个 IP，不再二次解析。HTTPS 走 CONNECT，只放 443 / 80 端口。新的出站实现照这个标准。
- 日志与错误里不带密钥（E2B 的 API key、envd 令牌）和其他组织的 id。

## 测试

- **内核测试用假沙箱**：`packages/kernel/test/fixtures/plugins/sandbox-fake`，部署配置 `{ root }`，多个副本共用一个
  root 就共用同一批实例。辅助函数 `readFakeSandboxOps`（操作计数）、`removeFakeSandbox`（模拟 gone）、
  `setFakeSandboxDelays`（慢操作）、`fakeSandboxState`。用例见 `packages/kernel/test/sandbox/*`、
  `packages/kernel/test/tools/sandbox/sandbox-tools.test.ts`、`packages/kernel/test/skills/m5-segment3.dual.test.ts`。
- **Docker 插件**：`plugins/sandbox-docker/test/docker-env.ts` 的 `buildTestImages`（唯一标签）、`startSocketProxy`（真实 HAProxy）、
  `cleanupTestResources`（按标签清理）；没有 Docker（或 `CAPYBARA_TEST_NO_DOCKER=1`）整组跳过，runsc 用例只在守护进程登记了
  runsc 时跑。仅测试的选项（额外标签、`egressTestHosts`）走 `createDockerSandbox` 的第二个参数，插件配置 strict、设不了。
  socket 代理的规则改动要配真实代理的违规用例（证明会被拒）。
- **E2B 插件**：`@capybara-hq/testing` 的 `startFakeE2B`（控制面 + envd，命令在本机临时目录里真的跑）；真实 E2B 的
  `test/live` 只在设了 `CAPYBARA_TEST_E2B_API_KEY` / `CAPYBARA_TEST_E2B_TEMPLATE` 时跑，文件头列出「只能在真实环境确认的
  假设」，第一次跑时逐条核对。
- **双副本**：`packages/kernel/test/sandbox/m5-segment2.dual.test.ts`（真实 Docker，杀执行副本后接手、休眠后恢复）。
- 每个提供方至少覆盖：gone 与普通错误的映射、中止（调用前 / 进行中）、超时杀掉整组进程、自动启动、killAll、
  同名替换、`/skills` 经符号链接写入被拒、出站三种模式、输出截断在 UTF-8 边界。
- 真实运行时的人工验收（runsc、E2B、CI amd64）见 `docs/superpowers/plans/m5-live-acceptance-checklist.md`。
