---
"@capybara-hq/kernel": minor
---

产物预览与对话沙箱状态（M5 T11，网页产物标签与上下文标签用）：

- 产物下载 `GET .../conversations/:id/artifacts/:artifactId/download` 新增 `?inline=1`：只对位图
  （PNG / JPEG / GIF / WebP）以 `inline` 打开（缩略图），SVG、HTML、文本等其余类型仍一律 `attachment`。
- 新接口 `GET .../conversations/:id/artifacts/:artifactId/preview`：文本类产物（`text/*` 与 JSON / XML /
  YAML / SQL）按 Range 读开头 8 KB、至多 40 行，返回 `{ preview: { text, truncated } }`（`no-store`）；
  其他类型 → 新错误码 `conversation.artifact_not_previewable`（400）。访问规则同下载。
- 新接口 `GET .../conversations/:id/sandbox` → `{ status: "running" | "suspended", lastUsedAt }`；
  未创建、已销毁或正在创建 → 新错误码 `sandbox.not_found`（404）；会话可见性同会话流。
  `SandboxService` 新增只读的 `status(orgId, conversationId)`。
