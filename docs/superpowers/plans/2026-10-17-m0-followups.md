# M0 遗留事项（写 M1 及后续计划时对照）

来源：M0 子代理执行记录中推迟处理的轻微问题，以及最终整分支评审的建议。已在最终修复波次修掉的条目不在此列。

## 仍待处理（原「建议 M1 处理」中未纳入 M1 的）

- Nacos 鉴权（用户名/密码/accessToken）——与身份组织无关，单独小任务处理

## M6（市场）前必须处理

- 市场侧检查忽略 allow-module-state 豁免标记（或改为白名单登记）
- 检查的剩余绕过：workspace:<相对路径> 依赖；npm:@capybara-hq/testing 别名绕进非测试源码；非测试源码 re-export 测试文件绕过 plugin-state；sdk 的 src/dist 不扫
- semver.satisfies 加 includePrerelease（发预发布 SDK 前）

## 其余轻微项（择机处理）

- Task 1: minor (deferred): ci.yml 缺 permissions: contents: read 与 concurrency 组
- Task 1: minor (deferred): biome.json 的 `recommended` 弃用 info 常驻 lint 输出
- Task 1: minor (deferred): compose.dev.yaml 无 healthcheck
- Task 2: minor (deferred): schema.ts .prefault({} as never) 类型强转，缺注释
- Task 2: minor (deferred): 无 masterKeyPrevious / roles 测试
- Task 2: minor (deferred): 带引号的 JSON 字符串值（"hello"）现在保留引号，行为未记录/未测
- Task 3: minor (deferred): 立即返回空 200 的代理会造成 watch 热循环（Nacos 本身挂 30s，理论问题）
- Task 3: minor (deferred): selectConfigSource 拒绝空 namespace，public 命名空间需显式写 public（需文档）
- Task 4: minor (deferred): CI 需预拉 postgres:17 / valkey/valkey:8，否则首跑超 120s
- Task 4: minor (deferred): vitest alias 指向 testing/src，需注释说明原因
- Task 4: minor (deferred): startTestRedis 无正式测试（Task 7 会实际使用）
- Task 4: minor (deferred): pg_terminate_backend 测试用固定 500ms 等待，非事件驱动
- Task 5: minor (deferred): allow 注释按「上一行」判断，同行多语句时可豁免非首语句
- Task 6: minor (deferred): definePlugin(null) 抛裸 TypeError 而非 PluginManifestError
- Task 6: minor (deferred): plugin-sdk 把 kysely 放 dependencies（仅类型用），可改 peer/dev
- Task 6: minor (deferred): parseCapability 的 channel@ / channel@x / @1 / channel@1.2 拒绝用例未测
- Task 7: minor (deferred): 每次 eval 发整段脚本，可改 defineCommand/EVALSHA
- Task 7: minor (deferred): ttl 校验逻辑在 kv.ts 与 lock.ts 重复
- Task 8: minor (deferred): delayMs 负数 / concurrency 0 未校验
- Task 9: minor (deferred): 篡改测试只翻 data 末字节、断言宽泛；未测篡改 tag/IV/截断
- Task 9: minor (deferred): rewrap 未知 id 测试依赖共享库数据与前 20 条截断
- Task 9: minor (deferred): rewrap 的运维顺序（所有副本先换 keyring 再 rewrap）未写进 JSDoc
- Task 10: minor (deferred): semver.satisfies 未加 includePrerelease，SDK 预发布版本会拒绝所有插件
- Task 10: minor (deferred): 插件 requires 自己也 provides 的多选能力时报自环
- Task 11: minor (deferred): 测试缺口：runStart/runMigrate（启动失败资源释放、stop 等在途任务、30s 上限、api-only 不消费已在 M1 补上）
- Task 11: minor (deferred): 非 hot 键变化后每次热更新重复 warn；runStart catch 日志标签误导
- Task 12: minor (deferred): cli.ts 的 env -S shebang 在 busybox/alpine 可能不支持
- Task 12: minor (deferred): DROP DATABASE WITH (FORCE) 需 PG ≥13，pgUrl 文档应写明
- Task 13: minor (deferred): .d.ts 的 declare let 误报；docs 逐字节比对在 CRLF 检出下误报
- Task 13: minor (deferred): workspace:<相对路径> 依赖未拦（未实测）；npm:@capybara-hq/testing 别名可绕进非测试源码；非测试源码 re-export 测试文件可绕 plugin-state；sdk 的 src/dist 不扫
- Task 14: minor (deferred): 哨兵 CLI 的 exit(1) 路径无测试（只测了 helper）

## M1 已处理

M1 计划（`2026-10-17-m1-identity.md`）「本计划纳入的 M0 遗留事项」表中的条目，均已在 M1 分支处理：

| 遗留事项 | M1 任务 | 提交 |
|---|---|---|
| 停机分阶段时间预算；start 卡超 30s 后 host.load 晚于 host.close 的泄漏 | Task 2 | `b3d5c50`、`fcd6a29`、`f016deb` |
| pg Pool 加 `connectionTimeoutMillis`（新增 `db.connectTimeoutMs`） | Task 2 | `b3d5c50` |
| 插件按依赖拓扑逆序关闭 | Task 2 | `b3d5c50` |
| worker-only 角色没有健康端点 | Task 2 | `b3d5c50` |
| `ctx.db` 包一层，阻止插件调用 `destroy()` | Task 2 | `b3d5c50` |
| PluginHost 对相对路径 `resolveFrom` 做 `path.resolve` | Task 2 | `b3d5c50` |
| 测试缺口：启动失败资源释放、stop 等在途任务、api-only 不消费 | Task 2 | `b3d5c50` |
| pluginConfig 中没有对应插件的键要告警 | Task 3 | `ff8144f` |
| 带 `-` 的插件名无法用嵌套环境变量寻址 | Task 3 | `ff8144f` |
| `CAPYBARA_DB` 与 `CAPYBARA_DB__URL` 冲突未检测 | Task 3 | `ff8144f` |
| `CAPYBARA_CONFIG_SOURCE=""` 视为默认 | Task 3 | `ff8144f` |
| pluginConfig 密钥未纳入日志打码 | Task 3 | `ff8144f` |
| AGENTS.md 未写明完整依赖链（M0 Task 1 轻微项，顺手处理） | Task 12 | M1 Task 12 提交（`test: M1 双副本端到端验收，补充内核 API 技能与文档`） |
