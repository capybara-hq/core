---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Transactional outbox follow-ups. Retrying a dead outbox row that is owed again twice while it is
retried answers 409 `conflict` instead of an internal error, and its audit detail always names the
row's own queue and job. A run job that read a run as queued before a stop ended it records no
skills catalog or run context for it. Allowing hosts always on a device no longer reports success
when the request was approved meanwhile with other hosts and the device did not confirm this
change. On the admin overview, a dead outbox list that cannot be read shows the group's
unavailable state with retry instead of a bare count.
