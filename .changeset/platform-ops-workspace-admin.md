---
"@capybara-hq/kernel": minor
"@capybara-hq/web": patch
---

Platform tool phase 2, workspace and admin operations: about 95 new operations.

- **Conversations** (your own): list, read, events, usage, files, sub-agents, the agent tree, the
  environment, rename, archive and unarchive. Delete and stopping another run of yours are never
  remembered. The new static `rememberable: false` marks an operation that always asks.
- **Skills and components**:
  - switch a skill, agent template or connector template on or off in the org;
  - share and delete skills;
  - for the super admin, component scope, deployment disable and "shown to other orgs" (all with
    previews), and updating an agent template.
- **Admin console** (super admin, own private agent only):
  - accounts: list, read, create, disable and enable;
  - orgs and their limits, deployment settings, models, prices and the default model per purpose;
  - plugins, extensions and marketplaces: deployment state, enable, disable, upgrade, scope, and
    import prepare.

  Admin data is shown in full. Items owned by other orgs are counted and refused.
- **Creating a user** takes no password:
  - the kernel generates a one-time initial password;
  - it is shown once, on the web, only to the super admin who approved;
  - it expires after 24 hours, and an hourly job removes unread ones;
  - the account must change it at first login.
- **Fence**: `check:platform-ops` gains `platform-op-double`, which reports a route that is both
  mirrored and excluded.
