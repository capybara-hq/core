---
"@capybara-hq/kernel": minor
---

`ctx.net.fetch` for extensions: the kernel's guarded client (`safeFetch`) with a per-call policy
(the org's allowed internal endpoints when `orgId` is given, public addresses only otherwise,
`net.httpsProxy` / `net.noProxy`, `net.allowInsecureLoopback` for tests). Loopback is refused
whatever the allowances, link-local and the cloud metadata endpoints `100.100.100.200` and
`fd00:ec2::254` always (also for marketplace downloads). Redirects: `redirect: "manual"` returns
the 3xx, otherwise `net.redirect`. Refusals reject with the SDK `NetDeniedError`.
