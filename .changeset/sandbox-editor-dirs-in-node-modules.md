---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
---

The restricted write policy treats `.idea` and `.vscode` as ordinary names below a `node_modules`
component (rule 7, `SANDBOX_DEPENDENCY_EXEMPT_NAMES`): packages ship them (pnpm's own tarball
unpacks `iconv-lite/.idea`), so the deny broke pnpm inside the sandbox. Elsewhere they stay denied.
