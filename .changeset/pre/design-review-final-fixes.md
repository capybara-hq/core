---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

Design review fixes: release-candidate tool keys in frozen sub-agent definitions are rewritten
(migration 0144); readiness counts only the model services an organization can see and turn on; the
notice of an unreadable template skill is shown with the sub-agent's task; a process that swallowed
a fatal event stops gracefully and exits 1; a switch-on whose install vanished answers a retryable
conflict; the web labels the git push policy audit action, enables a disabled model service from
`/admin/models`, repairs an unreadable forbidden list from its notice and shares one Load more.
