---
"@capybara-hq/design": patch
"@capybara-hq/web": patch
---

Keep a running tool row's elapsed time on one line (§6.16.9): beside a long description, such as a
command review's reason, the label now yields with its ellipsis and 「6 秒」 is no longer squeezed
into one character per line. The live timer is a status like the waiting word beside it: `flex:
none`, `nowrap`.
