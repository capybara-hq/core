---
"@capybara-hq/web": patch
---

Server-rendered pages, final fixes: the web proxy also renews a session whose access cookie is
about to outlive its token (less than 30 s left), and a browser refresh that loses the race to the
proxy (`auth.refresh_race`) retries its request with the winner's cookies instead of failing. The
home page's inbox and conversations are secondary panels with their own error state, and when an
org stops being ready while the ready shell is still shown, the home page re-reads the layout. After
transferring ownership, owner-only member actions disappear at once. The client-side page gates
(`AdminGate`, `RoleGate`, `OrgGate`, `RequireSession`) are removed; pages gate on the server.
