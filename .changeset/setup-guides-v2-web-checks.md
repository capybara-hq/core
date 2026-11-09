---
"@capybara-hq/web": patch
---

Live setup check rows: the 接入指南 of a channel connection, a connector made from a template
(admin text) and the 如何连接 sheet (member text, its checks only) read the checks' cached states,
run each row without a fresh result (at most four at a time), poll while a run is in progress
elsewhere, and offer 重新检查 (a forced run that waits out its cooldown). Too many runs keep the
last results with a muted line. Saving a connection, connector or credential reads the states
again. New channels, the install wizards and the super admin's template page keep static rows.
