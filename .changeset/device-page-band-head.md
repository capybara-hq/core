---
"@capybara-hq/capybara": patch
---

The device page is one head and two views: its name band is the page's head (a new `DetailPage`
form, `header.titleHidden`) with the 概览 / 设置 tab row under it, 概览 shows values only (network
hosts, resources, the machine's system, files, recent changes) and 设置 holds every control as
settings sections — the run mode as card radios with one consequence each, the network allowlist
with an add dialog, disconnect, and a danger zone for delete. The page's one-off mode scale is gone,
and the sandbox mode reason reads as a statement instead of repeating the mode it already shows.
