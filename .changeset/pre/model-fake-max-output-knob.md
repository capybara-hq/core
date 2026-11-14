---
"@capybara-hq/plugin-model-fake": patch
---

The fake models declare the standard `maxOutputTokens` knob: an agent or a trial can cap a reply,
and a reply is cut at the cap the kernel sends (which the kernel lowers when the window leaves less
room).
