---
"@capybara-hq/web": patch
---

The eval pages (sets, a new set, a set, the run wizard, a case's snapshot trajectory, a run with
the first 200 results) are rendered on the server behind the org-admin gate; an active run keeps
polling after the first paint and further result pages load with "Load more". The runs list reads
its filters from the query (a filter change is a navigation) and its first page on the server; a
trajectory reads its latest runs once on the server (each read is audited). An extension's org
page reads its view on the server and keeps live refreshes after the first paint.
