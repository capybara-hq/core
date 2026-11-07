---
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

A conversation's history loads from the end: the page paints the log's last page and reads earlier
pages as the reader scrolls up, without moving what is on screen. `GET …/conversations/:id/events`
takes `before=<seq>` or `before=end` for a turn-aligned page (it starts after a run's end) with
`turnsBefore`, the runs started before it. Sub-agents, usage and background tasks are read from
the server when the loaded part may hide them.
