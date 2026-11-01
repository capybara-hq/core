---
"@capybara-hq/web": patch
---

The eval pages (sets, a new set, a set, the run wizard, a case's snapshot trajectory, a run with
the first 200 results) are rendered on the server behind the org-admin gate; an active run keeps
polling after the first paint and further result pages load with "Load more". The runs list reads
its filters from the query (a filter change is a navigation) and its first page on the server; a
trajectory reads its latest runs once on the server (each read is audited). An extension's org
page reads its view on the server and keeps live refreshes after the first paint.

The sign-in page takes `returnTo` and `error` from the query and its sign-in sources from the
server, and sends a visitor who is already signed in on to `returnTo`; signing in, setting up and
signing up through an invitation tell the other tabs. The invitation and binding pages read their
token on the server (signed out, the binding page goes to sign-in before it renders).
