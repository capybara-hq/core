---
"@capybara-hq/design": minor
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

`AppShell` (and `SetupPage`) take a `banner`: a shell-wide row (safe mode's `SafeModeBanner`) drawn
as the shell's first grid row across the sidebar and the content column, which share the rest of
the window. In safe mode the web draws its banner there instead of above the 100dvh shell, so the
status bar and the bottom of the page are no longer clipped.
