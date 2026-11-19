---
"@capybara-hq/design": patch
---

`ModeMenu` (spec §6.16.3a): the composer's mode button and menu with described profile rows, a
key hint in the head and the effort as segments; `ComposerBox` takes `mode`, draws the model
picker as "model · effort" and moves to the next mode on Shift+Tab. Menu entries gain `segments`
and a label `hint`. `ToolRow` shows a crossing approved automatically.
