---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/plugin-tools": patch
---

Breaking for route authors: every `permissions.http` entry declares `access` (`public`, `embed`,
`member` or `admin`) instead of `public?: boolean`. A route handler is called with the caller the
kernel resolved (`ctx.http.route(method, path, (req, caller) => ...)`, `RouteCaller`); `member` and
`admin` routes mount under `/plugins/<name>/orgs/:orgId<path>`, `embed` routes live under `/ui/`, and
an embed contribution's `path` must be declared as a `public` GET. `capybara-plugin check` fails a
manifest whose route has no valid `access`.
