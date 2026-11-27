---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Directed events and acceptance (collaboration spec §4.4): an extension's directed event (work
assigned to a member and their agent) follows the member's acceptance rule for its source, else
the org's `automations.directedDefault` (default `auto`). `auto` makes the member's acceptance
automation once (subject mode, no grants, asks the member on anything outside them) and runs the
work; `confirm` posts a work offer to the member's inbox (accept runs it, decline tells whoever
assigned it); `off` runs nothing. Members set their rules on `/account/automations` (`GET`/`PUT
automations/acceptance`, Platform operations `automations.acceptance-get`/`-set`); offers are
accepted or declined only by the member on the web (`POST automations/offers/:id/accept|decline`).
Directed events stored before this release are dispatched again by migration 0192.
