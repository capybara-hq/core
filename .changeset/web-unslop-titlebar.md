---
"@capybara-hq/web": patch
---

The conversation title bar's buttons open the panel they name: Files appears once the conversation
has a file and opens it, More appears only when two or more icons don't fit. No overflow menu holds
a single action any more (it is drawn directly) and no menu repeats a visible action. The status
bar signs every page `<login>@<org slug>:~/<path>` (`/admin/<path>` in the admin console), the
conversation page included, with the time zone; error and not-found pages keep the page's path in
their head, and the title-bar path is spaced like the page head's.
