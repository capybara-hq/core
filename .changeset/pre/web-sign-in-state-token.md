---
"@capybara-hq/web": patch
---

The shell's `data-cap-state` carries `sign-in=new` from the server render on the first workspace
document of a sign-in, so plugin CSS can cover the page until a boot screen takes over.
