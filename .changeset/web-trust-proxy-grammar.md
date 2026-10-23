---
"@capybara-hq/web": patch
---

`CAPYBARA_WEB_TRUST_PROXY` accepts the kernel's `http.trustProxy` list grammar: dotted netmasks,
the names `loopback` / `linklocal` / `uniquelocal`, IPv4-mapped IPv6 ranges and a JSON array, so a
value copied from the kernel no longer stops web at startup. The plain-http notice on the login page
also says to set `CAPYBARA_PUBLIC_URL`, without which attachments fail.
