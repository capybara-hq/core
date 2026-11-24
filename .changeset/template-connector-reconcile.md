---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/testing": patch
---

The connector templates on in an org that the org never had a connector from (none live or
deleted, none recorded on an install) now get their connector without input. This happens after an
install commits and after an org switches an extension on (a `template-connectors-ensure` job on
the new queue `cap-template-connectors`, retried while the connector extension is not loaded on
the replica yet), when the scope sync adds a plugin's dependencies, and once at the first start
after this release (under `lock:bootstrap`, skipped by a replica that does not get it, marked done
in `deployment_settings`); a five-minute sweep (`template-connectors-sweep`, once per tick across
replicas) catches what none of these re-trigger, such as a kind loaded after the queued ensure gave
up or an always-on connector extension. A connector an admin deleted is never made again. During a rolling
upgrade, replicas of the previous version neither owe nor consume these jobs: the startup pass of
the first upgraded replica covers what was waiting, and jobs owed meanwhile wait in the outbox until
an upgraded worker takes them. The first start after this release runs that reconciliation pass inside
the start sequence, before the replica reports ready: on a large deployment (many orgs with
installed plugins that have connector templates) that first start takes longer. The health overview lists the new queue ("Template connectors" /
连接器模板补建). The dual-replica harness takes `beforeStart` to seed the fresh database before the
replicas start.
