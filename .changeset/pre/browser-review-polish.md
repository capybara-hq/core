---
"@capybara-hq/design": patch
"@capybara-hq/web": patch
---

Browser review polish: plain links in tables draw in ink instead of the browser's link colour;
a disabled ghost or icon button no longer gains a border; page header actions sit on the title
line on every page; the status bar keeps 「第 N 轮 · 已用 …」 whole and shrinks the prompt first;
the thread fades at its scroll edges; context lines never break inside a word; tab rows that do
not fit fade where tabs are hidden; Markdown code blocks get a copy button and Markdown tables row
lines and room; the extension tables' state, switch and 副本 columns fit their content (the 副本
cells drop the repeated word). One localized duration format, `formatDuration` (replacing
`runDuration`, `subagentDuration` and `elapsed`), so the status bar and the run row agree.
