---
"@capybara-hq/plugin-client": minor
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

Add `useSizeClass` and `useViewportSegments` to the plugin client (the window's size class and the
two segments of a folded display, read from the host). The kernel lists each contribution's compact
form (the slot's, narrowed by the contribution's), and the web does not draw a `hidden`
contribution on a compact screen.
