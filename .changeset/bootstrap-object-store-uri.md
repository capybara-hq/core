---
"@capybara-hq/capybara": patch
---

Bootstrap pins follow the plugins repository at `05d00a9`: `object-store-s3` 0.1.0-rc.9 → 0.1.0-rc.10
(it now reports its objects' unsigned URI, so the attachments-on-demand reference reads
`s3://<bucket>/…`) and `todo` 0.1.0-rc.10 → 0.1.0-rc.11. The compose files' sandbox build contexts
move to the same commit.
