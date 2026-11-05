---
"@capybara-hq/web": patch
---

Add the server data layer for server-rendered pages: a server transport for `apiFetch` that forwards the session cookie and peer address, deduplicates reads per request and never mutates, the page helpers `read` / `optional`, the session gates `getSession` / `getShell` / `workspace` / `admin`, and `useLoad({ initial })` / `useServerState` for views seeded with server data.
