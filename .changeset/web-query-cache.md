---
"@capybara-hq/web": minor
---

Every web read goes through TanStack Query. A first load still paints complete from the server
(the layouts prefetch the route's reads from one route table and hand them to the browser's
cache); navigating inside the app reads from that cache: a page seen within its freshness window
paints at once with no kernel read, a stale one paints and refreshes in the background, and a page
with nothing cached shows its template's loading state. Saves invalidate exactly the data they
change, an org switch or sign-out clears the cache, and a missing object shows the not-found state
inside the shell.
