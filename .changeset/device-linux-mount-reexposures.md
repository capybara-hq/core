---
"@capybara-hq/device": patch
---

Linux: every operation start reads `/proc/self/mountinfo` and denies each path where another mount
shows a denied directory or something inside it (a bind mount, a mount of an ancestor's subtree, a
file system mounted inside it and elsewhere, an overlay layer), under every project reach, so the
carve no longer leaves a bind mount of `~/.ssh` readable. A mount table it cannot read or decide
refuses machine project reach with the cause and `capybara-device ceiling set --project-reach
paths`; `ceiling` shows the cause.
