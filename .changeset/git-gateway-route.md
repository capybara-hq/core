---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The api role serves the git gateway `GET` / `POST /git/v1/<host>/<owner>/<repo>/…`: git smart-HTTP
for sandboxes, authenticated by a run ticket (`Authorization: Bearer`), relayed to the host with the
actor's connector credential (re-resolved per request), streamed both ways with no redirects, only
the spec's headers, a byte cap per run, a per-org concurrency cap and an idle timeout. Pushes follow
the `git_push` policy before any byte reaches the host; a held or refused push is answered in git's
own protocol (`remote: Capybara: …`) and recorded for the exec.
