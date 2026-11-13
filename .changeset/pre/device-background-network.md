---
"@capybara-hq/device": patch
---

A background task on macOS keeps its launch's network permissions until its process group ends; it lost them (proxy 403) as soon as the launch returned.
