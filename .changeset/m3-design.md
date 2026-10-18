---
"@capybara-hq/design": minor
---

- 新增 `@capybara-hq/design` 设计系统（token、控件、DataTable、浮层、App Shell 与 12 个页面模板，规格见 `docs/design/spec.md`），Web 页面全部迁移到页面模板 + design 组件；新增 `/dev/ui` 组件目录页与截图回归、`pnpm check:web-ui` 界面规范检查及技能 `writing-web-ui`。
- TopBar 一级导航项支持 `count`：大于 0 时在名称后以计数 Badge 显示（超过 99 显示 `99+`），可访问名称为「名称，n 项待处理」/「Label, n pending」，窄屏收进「更多」时写进菜单文案（spec §4.1）。
