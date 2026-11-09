---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A plugin whose client code was built for a newer client API than the kernel's `CLIENT_API_VERSION`
is refused at import with `client.api_unsupported` (400), and the client shell reads never list a
build of a client API version the web host does not run.
