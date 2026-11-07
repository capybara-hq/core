---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

The model is told when its tool set changes mid-conversation: a step whose resolved tools differ
from the previous request's logs a `tools_changed` event (added and removed tool names) before its
request, rendered as a system message ("Your tools changed. Now available: … No longer available:
…"). Step replay rebuilds it from the log with zero drift; the web timeline ignores it.
