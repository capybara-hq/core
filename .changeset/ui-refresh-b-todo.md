---
"@capybara-hq/plugin-todo": minor
---

Tasks as an inline card, a properties section and a right panel: views `tasks-panel` (panel, icon `list-checks`), `tasks-section` (badge done / total, each item opens the panel at that item) and `tasks-card` (the inline card `todo__write` returns as `card`, showing the list as of that call; the latest 50 snapshots per conversation are kept, older cards show the current list). The old view id `tasks` stays as an alias of `tasks-panel` for one release.
