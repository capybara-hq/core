---
"@capybara-hq/plugin-object-store-s3": minor
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
"@capybara-hq/capybara": patch
---

对象存储落地：新插件 `@capybara-hq/plugin-object-store-s3`（`object-store@1`，官方 `@aws-sdk/client-s3`，覆盖 AWS S3、MinIO、Ceph、OSS、TOS 等 S3 兼容服务；部署配置 `endpoint`、`region`、`bucket`、`accessKeyId` / `secretAccessKey`（密钥）、`forcePathStyle`、`publicEndpoint`）。SDK 契约变更：`presignPut` 改为返回 `PresignedUpload`（`{ method: "PUT" | "POST", url, headers, fields? }`），S3 实现用带 `content-length-range` 的 POST 策略，让存储端拒绝超过 `maxSize` 的上传；列举结果的 `contentType` 为空串。内核：新增 `StorageService`（`available`、`forPlugin`、`kernel(orgId)`、`deleteOrg`），`ctx.storage` 经它加前缀 `plugins/<插件>/<orgId>/`，键与 orgId 校验（UUID、无 `..` / `.` 段、不以 `/` 开头、无 `\` 与控制字符、≤ 1024 字节），列举只返回本前缀下的键；声明了 `permissions.storage` 而没有提供方时插件不加载（pending，原因 dependency），依赖排序把提供方排在前面；错误码 `storage.unavailable`（503）；迁移 `0021` 与配置 `storage.purgeDeletedOrgsAfterDays`（默认 30）：维护任务清理软删除超过该天数的组织的对象。测试工具：`startTestMinio()`。CLI：`plugins review` / `approve` 说明缺少提供方的依赖。
