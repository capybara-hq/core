---
"@capybara-hq/web": patch
---

The public share page `/s/<code>`: the shared file rendered full width the way the right panel
renders it (the HTML document, an extension previewer with a share-scoped token, or a built-in),
with who shared it, the expiry and Download. It loads no workspace data, is not indexed and sends
no referrer; an internal link without a session signs in first and comes back, and a dead link
shows one "This link is invalid or has expired" page. A view previewer that declines the share
gives way to the next one, then the built-in, then Download.
