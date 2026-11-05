---
"@capybara-hq/web": patch
---

The web tier keeps idle keep-alive connections open for 65 s instead of Node's 5 s (plus its 1 s
buffer), configurable with `CAPYBARA_WEB_KEEP_ALIVE_TIMEOUT_MS`. A load balancer or client reusing
a connection just as the web tier closed it got a reset (a 502 at the proxy) before the request
reached Next.
