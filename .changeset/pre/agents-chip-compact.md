---
"@capybara-hq/design": patch
"@capybara-hq/web": patch
---

The composer's agents chip reads 「N 个智能体」 / "N agents" alone, as Claude Code's "● 3 agents": the
running count is no longer drawn, and the leading dot carries the state (the running accent while a
sub-agent runs, warn while one waits, faint once all have finished). Its accessible name and
tooltip keep the counts.

The agent map follows one colour rule for every status dot (tree, level 2 head, legend, Agent call
block, chip): running accent, waiting and limit warn, completed faint, stopped a hollow faint ring,
failed fail. Its count line drops the running count (「N 个智能体 · 点击查看详情」), and a node names
its model only on the root or where it differs from the root's.
