---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
---

技能格式与组织技能库（M5 T13）：SDK 新增纯函数 `parseSkillMd`（Agent Skills frontmatter：name 小写字母 / 数字 /
单个连字符、≤64，description ≤1024 且不含 XML 标签，未知键忽略）、`validateSkillPackage`（必须有 SKILL.md、单文件
≤10MB、总量 ≤50MB、≤1000 个文件、路径不越界、不重复含大小写冲突）与 `SKILL_LIMITS`。内核新增迁移 `0024_skills.sql`
（`skills` / `skill_versions`，附件新增 `purpose` 列）、技能包上传用途 `skill-package`（admin、application/zip、
≤50MB、单独的待完成上限与 1 小时过期、不能当附件发送或下载）、按恶意输入处理的 zip 解包（yauzl 3.4.0），以及接口
`POST /orgs/:orgId/skills/uploads`、`POST/GET /orgs/:orgId/skills`、`GET/DELETE /orgs/:orgId/skills/:id`
（动作 `skills.read` member、`skills.manage` admin；错误码 `skill.not_found`、`skill.invalid_package`）。
agent 定义新增可选的 `skills.orgSkills`（保存时校验属于本组织且未删除）。
