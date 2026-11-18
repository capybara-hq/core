---
"@capybara-hq/web": patch
---

HTML files render in the right panel as a whole sandboxed document (a built-in that wins over
extension previewers, with a Source option), and every available file gets a Share dialog: who
can open the link, its expiry within the platform maximum, the link to copy, and the file's
active links with Copy, Update to latest and Revoke. The panel's body is one component behind a
file source, so the share page renders files the same way.
