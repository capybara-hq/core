---
"@capybara-hq/kernel": patch
---

`Write` over an existing file now reads up to 10 MB of the old content to record its digest in
`view.file`, and fails (instead of writing) when the old content cannot be read for a reason other
than the file being gone.
