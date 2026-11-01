---
"@capybara-hq/web": patch
---

The organization settings (general, sandbox, members, models, plugins, extensions, service tokens)
and the personal settings (connections, remembered approvals, identities) are rendered on the
server: they paint complete, behind the same role gates, with no browser read before the first
paint. A change re-renders the page on the server.
