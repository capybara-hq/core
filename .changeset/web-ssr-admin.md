---
"@capybara-hq/web": patch
---

The admin console (overview, accounts, organizations, deployment settings, models, extensions and
the extension wizard, the deployment catalog and its import and requests, marketplaces and their
entries) is rendered on the server behind the enterprise-admin gate: pages paint complete with no
browser read before the first paint. Enabling or configuring a model provider refreshes the
workspace readiness, so returning to the home page shows the shell, not a stale setup frame.
