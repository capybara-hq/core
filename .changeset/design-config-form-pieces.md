---
"@capybara-hq/web": patch
---

Design: three pieces for extension config forms. `Repeater` draws an array of objects as hairline
item cards (title, subtitle, drag handle, move up / down, remove with an undo toast, collapse) or
as compact rows, with an add button or a menu of presets plus 空白, Alt+↑/↓ to reorder and focus on
the new item's first field; `FieldRow` is a compact row of small fields with labels on the first
row only, a per-row 高级 disclosure and a stack below 640; `KeyValueEditor` edits a record as key /
value rows. Menu items may carry a description, and a success toast may carry an undo action.
