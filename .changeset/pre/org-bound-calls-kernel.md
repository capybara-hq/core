---
"@capybara-hq/kernel": patch
---

Every org-bound extension call (web search / fetch, directory sync, extension tools, UI views and actions, file previews, hooks including `usage.report`) carries the extension's effective config for the org; an org whose effective config is not valid gets no call (excluded from point resolution and directory sync, tool not dispatched, UI 409 `extension.needs_config`, previewers left out, policy hooks deny and observe hooks are skipped). The CLI context now provides `CacheService`, which `capybara extensions` commands need.
