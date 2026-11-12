---
"@capybara-hq/capybara": patch
---

An extension's properties section whose schema view has nothing to show (no blocks, or only empty
lists) is no longer drawn: no header, badge or empty state until it has content (the todo
section before the agent's first to-do), and no skeleton during its first load.

The bootstrap `todo` plugin moves to 0.1.0-rc.8 (the plugins marketplace at 4bfd588): the list is
titled 「待办」 / "Todos" and its properties section stays hidden until the first to-do.
