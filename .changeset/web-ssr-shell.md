---
"@capybara-hq/web": patch
---

The signed-in frame is drawn on the server: the shell, the setup frame (with its steps in the
sidebar) or the org chooser paints at once from the layout's data, with no loading frame. Org
switches keep the current page until the new org's frame is ready, sessions follow sign-in, sign-out
and org switches across tabs, and a starting kernel or a failed page retries by itself.
