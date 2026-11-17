---
"@capybara-hq/design": patch
---

Keep a code block's or a markdown table's classic scrollbar inside the block in Safari: WebKit did
not lay out flex ancestors again when the scrollbar appeared, so it hung over the next row (the
command approval card's buttons).
