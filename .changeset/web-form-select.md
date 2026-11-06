---
"@capybara-hq/web": patch
---

Form selects and the conversation composer (acceptance batch 3).

- Every form select opens the design system's own list instead of the browser's popup: the
  composer's anchored menu as a listbox, below the field (above it when the room below is short),
  at least the field's width, capped in height, the selected option checked; a filter above ten
  options; arrows, Enter, Space, Escape and typeahead; forms still submit and validate it.
- Space on a focused item of a filterable menu picks it.
- On a conversation the composer no longer repeats the agent: the title bar's path names it.
- The zh copy calls an agent's owner 所有者 everywhere (never 负责人).
