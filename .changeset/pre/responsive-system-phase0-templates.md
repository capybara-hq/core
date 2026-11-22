---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

The templates take their compact forms (responsive system phase 0, second part). Below 600 every
`ObjectList` is one grouped list of rows: a row that opens something shows no buttons, ends in a
chevron and opens its actions in an action sheet on a long press or right click, and a row that
opens nothing keeps its one button and a labelled ⋯. The page head is the compact head (no path
row, a large title with its count, the primary as a block or head button, the secondaries in the
shell's "…", full-width search and a segmented first-level tab row). Every pushed template is one
scroller with a title that scrolls away and a quick-return search bar, and the compact ListPage
draws a scope chip row, a floating primary and restores its scroll position. The workspace
agents page uses the typed list scope instead of a segmented control in its filters.
