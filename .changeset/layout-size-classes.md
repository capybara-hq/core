---
"@capybara-hq/web": patch
---

The layout follows size classes (compact below 600, medium 600 to 840, expanded from 841) instead of
the old 640 / 960 / 1280 widths. From 841 the sidebar keeps its full form and can be collapsed to the
icon rail with its toggle or Ctrl+\ (⌘\ on a Mac); the choice is remembered. On a medium window the
rail has a Conversations button that opens the conversation list as a side sheet. A short window
(under 480 high) hides the status bar and the page path.
