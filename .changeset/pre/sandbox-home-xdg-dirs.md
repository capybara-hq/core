---
"@capybara-hq/device": patch
---

The device creates the XDG base directories and `Library/Caches` of its sandbox home before each
sandboxed command: the sandbox may not create a directory leading to a protected entry (`.config`,
`.local`, `Library`), so pnpm found no data directory there and put its store in the repository.
