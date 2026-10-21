---
"@capybara-hq/kernel": minor
---

技能目录与 `skill_load`（M5 T14，Ruling M17）：

- 新事件 `skills_catalog {skills:[{id,name,description,version}]}`：运行开始时解析此刻对这个对话生效的技能
  （运行所用 agent 版本选中的组织技能 + agent 自己的技能，跳过已删除的，取 `current_version`；同名时 agent 自己的优先），
  与日志里最新一份快照不同才写（每次运行最多一份）；从没有技能的 agent 不写。新部分索引（迁移
  `0025_skills_catalog_idx.sql`）。`EventLog.latestOfType` 取某类事件的最新一条。
- 模型看到的目录只来自日志：第一份快照（在任何 `model_call` 之前）按名字排序接在 system 缓存段末尾，英文说明
  「需要时调用 `skill_load`」；之后的快照在所在位置渲染为英文变更提醒（新增 / 更新 / 移除），前缀不变；
  被压缩摘要覆盖时紧随摘要补一条完整的当前目录。请求可由日志还原。
- 内置工具 `skill_load {name}`（默认 allow、只读）：按最新快照把名字解析为 id 与版本，返回该版本 SKILL.md 正文与
  文件清单（结果写明版本）；技能已删除 → 可执行的英文错误。读出的文件按清单 sha256 核对。带其他文件的技能整个复制到
  沙箱 `/skills/<name>/`（只读），标记 `/skills/.capybara-skills.json` 记下 id 与版本，新建 / 重建沙箱或版本变化时
  重新复制；脚本用解释器运行（文件不可执行）。没有沙箱提供方时只给正文并说明脚本不可用。日志里有快照时由注册表
  自动加入（`forAgent` 新参数 `skillLoad`），不进 agent 定义。
