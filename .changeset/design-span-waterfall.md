---
"@capybara-hq/design": minor
---

新组件 `SpanWaterfall`（spec §6.10）：链路查看器上方的 Span 瀑布。`Span` 按 `parentId` 分层（run / step / model /
tool / wait），条形按偏移与时长在时间轨上定位，未结束的延伸到末端；`role="tree"`（总是展开），点击或 ↑ / ↓ /
Home / End 选中，空列表显示 `labels.empty`。另导出 `formatSpanDuration`（`312ms` / `6.8s` / `00:02:18`，未知 `—`）。
