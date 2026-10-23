---
name: writing-object-store-providers
description: 新建或修改对象存储插件（provides object-store@1，如 plugins/object-store-s3），或在插件 / 内核里用 ctx.storage、StorageService 时使用：ObjectStore 各方法的语义（range、list 分页、deletePrefix、不存在返回 null）、预签名上传必须由存储端限制大小（POST 策略的 key / content-length-range / Content-Type 条件）、拒绝含 ${ 的键、presignGet 的 disposition 与 responseContentType；内核加的键前缀 plugins/<插件>/<orgId>/ 与 kernel/<orgId>/、StorageKeyError、TTL 限制；组织删除后的清理任务；以及用 SeaweedFS（startTestS3）写测试。
---

# 写对象存储插件

对象存储放附件、沙箱交付的产物、技能文件和插件数据。`object-store@1` 是**单选、中转**能力：一个部署只装一个
提供方，插件不能 `requires` 它，只能经 `ctx.storage` 用（清单声明 `permissions.storage`）。通用插件写法见
`skills/writing-plugins`。

为什么和沙箱分成两份：两者的读者不同（存储插件作者 / 用 `ctx.storage` 的插件作者，与沙箱插件作者），契约和测试
手段也没有交集；技能按描述触发，分开写更容易被找到。

参考实现：`plugins/object-store-s3`（官方 `@aws-sdk/client-s3`，AWS S3、MinIO、Ceph、SeaweedFS、OSS / TOS 的
S3 兼容接口都能用）。

## 契约：`ObjectStore`（`packages/plugin-sdk/src/storage.ts`）

| 方法 | 语义 |
|---|---|
| `put(key, body, { contentType, size?, signal? })` | 覆盖同名键；`body` 是流时最好给 `size`；响应 `signal` |
| `get(key, { range?, signal? })` | 不存在返回 null；`range` 为闭区间，缺省 `end` 读到末尾；带 range 时 `head.size` 仍是**整个对象**的大小 |
| `head(key)` | 不存在返回 null；尽量带 `etag`（内核用它核对附件在 finalize 之后没被换掉） |
| `delete(key)` | 不存在也算成功 |
| `deletePrefix(prefix)` | 删前缀下的全部对象，返回删除数；要能跨多页（S3 一批最多 1000） |
| `list(prefix, { cursor?, limit? })` | 分页，`cursor` 缺省表示没有下一页；列举不带类型时 `contentType` 为空串 |
| `presignGet(key, opts)` | `downloadName` 进 `Content-Disposition`（RFC 6266，非 ASCII 用 `filename*=UTF-8''…`）；`disposition` 缺省 `attachment`；`responseContentType` 覆盖响应类型 |
| `presignPut(key, { contentType, maxSize, ttlSeconds })` | 返回 `PresignedUpload { method: "PUT" \| "POST", url, headers, fields? }` |

### 预签名上传：大小必须由存储端拒绝

- 预签名 PUT 限制不了大小，所以 S3 实现用 **POST 策略**（Ruling M3）。条件写全，不依赖 SDK 默认：
  `{ key }`（精确键）、`["content-length-range", 0, maxSize]`、`["eq", "$Content-Type", contentType]`。
  浏览器按 `fields` 原样放表单项，**最后**放文件字段 `file`。
- **拒绝含 `${` 的键**：POST 表单里键中的 `${filename}` 会被存储端换成上传方给的文件名，精确键条件就变成了
  「以某前缀开头」，上传方可以写到别处。插件与内核（`prefix.ts`）各拒一次。
- `ttlSeconds` 必须是 1..604800（SigV4 上限 7 天）的整数；内核传之前先 clamp。
- 换别的存储时先核实它**真的执行** POST 策略（SeaweedFS 已验证会拒超大、改键、改类型），做不到就别声明支持。
- 浏览器可达地址与内核访问地址不同时用 `publicEndpoint` 签名（主机名参与签名，不能事后替换）。CORS 由部署方在桶上配，见 README。

### presignGet 的打开方式

用户上传的内容只对不会执行脚本的类型（图片、PDF）用 `inline`，内核从不对别的类型给 inline（Ruling M9）；
`responseContentType` 让响应按内核核对过的类型返回，而不是存储里记的类型。

## 内核加的一层：`StorageService`（`packages/kernel/src/storage`）

提供方只看到完整键，前缀与隔离都由内核做（扩展模型 §5）：

- 插件拿到的 `ctx.storage`（`PluginStorage`）每个方法多一个打头的 `orgId`，键落在 **`plugins/<插件名>/<orgId>/`** 下；
  内核功能用 **`kernel/<orgId>/`**（附件 `attachments/…`、产物 `artifacts/<对话>/<id>`、技能 `skills/<上传 id>/…`）。
  部署级的内核数据在 **`deployment/`** 下（如插件包 `deployment/plugins/blobs/<sha256>.tgz`，PG 里记
  `plugin_packages.blob_store = 'object'`）。返回给调用方的键都去掉前缀，列举只保留本前缀下的对象。
- **换桶 / 换地址**：PG 只记「在对象存储里」，不记哪个桶。部署改了对象存储插件的桶或 endpoint 之后，旧桶里的对象
  （附件、产物、技能、插件包）在新桶里都找不到：插件包同步失败（副本状态 `sync_failed`，详情点名缺的键），
  附件等按「不再可用」处理。换之前把旧桶的 `deployment/`、`kernel/`、`plugins/` 前缀整体复制过去；
  插件包也可以重新上传同一个 tgz 补回。
- 校验在调用提供方之前：`orgId` 必须是 UUID（统一转小写）；相对键不能为空、不能以 `/` 开头、不能有 `.` / `..` 段、
  `\`、控制字符与 `${`，加前缀后 ≤ 1024 字节，否则抛 `StorageKeyError`。
- 没有提供方时各方法 reject `storage.unavailable`（HTTP 503）；声明了 `permissions.storage` 的插件不加载（pending，原因 dependency）。
- **组织删除后的清理**：维护任务 `storage-org-purge` 每小时认领一批已删除超过 `storage.purgeDeletedOrgsAfterDays`（默认 30）
  天的组织，`deletePrefix` 掉 `kernel/<orgId>/` 与每个插件的 `plugins/<插件>/<orgId>/`，成功后记 `storage_purged_at`。
  所以 `deletePrefix` 要可重入、可重试；孤儿对象（失败的上传、被拒的技能草稿）最终靠它清掉。
- 存储暂时出错时，构建模型请求不把媒体降级成占位，而是让这一步按可重试错误重来（Ruling M4），否则请求不可复现。
  提供方把暂时性故障如实抛出即可，不要吞掉、不要返回 null（null 表示确定不存在）。

## 写法要点

- 无状态：客户端按配置建，不在模块级缓存连接或凭据（多副本纪律）。密钥字段用 `secret()`。
- 流式上传 / 下载，不要把大对象整个读进内存。
- 错误信息不带凭据与签名。

## 测试

- `@capybara-hq/testing` 的 `startTestS3()`：官方 SeaweedFS 镜像（`TEST_S3_IMAGE`，可用 `CAPYBARA_TEST_S3_IMAGE` 换私有源），
  返回 `{ endpoint, region, bucket, accessKey, secretKey }`，用路径风格访问。开发编排 `docker/compose.dev.yaml` 用同一个镜像。
- 提供方至少覆盖：put / head / get（含 range）/ delete、流式 put（有无 size）、中止、list 分页、deletePrefix 跨多批、
  presignGet 的 disposition 与文件名、presignPut 超过 maxSize / 改键 / 改类型被**存储**拒绝、`${` 键被拒、TTL 范围、
  `publicEndpoint`。见 `plugins/object-store-s3/test/s3.test.ts`。
- 内核与用 `ctx.storage` 的插件测试直接加载 `object-store-s3` + `startTestS3()`，例子见 `packages/kernel/test/skills/*`。
