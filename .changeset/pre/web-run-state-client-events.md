---
"@capybara-hq/web": patch
"@capybara-hq/design": patch
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The shell element publishes `run=`, `theme=<plugin>/<file id>`, `motion=` and `sidebar=rail|full` in
`data-cap-state`; the open conversation's log is turned into client events on the client (history
loaded on open emits nothing). `ThemeRef` gains `key`.
