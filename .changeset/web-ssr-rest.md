---
"@capybara-hq/web": patch
---

The eval pages (sets, a new set, a set, the run wizard, a case's snapshot trajectory, a run with
the first 200 results) are rendered on the server behind the org-admin gate; an active run keeps
polling after the first paint and further result pages load with "Load more".
