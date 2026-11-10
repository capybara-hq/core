---
"@capybara-hq/kernel": patch
---

Client reports are bounded: a report's `contribution` must be null or a component id of that
build's manifest (another id is 404 `client.not_found`, a string outside the component id grammar
400), and the admin extension views read at most the newest 50 reports per extension in SQL. The
admin view's client build is the one a live replica serves (the old build beside an upgrade
awaiting approval or failed), not the install record's package. The delivery route refuses builds
of a client API version the kernel does not support, as the shell reads already omit them. A
replica whose running instance's own package goes pending or failed still reports serving it, so
its client code stays.
