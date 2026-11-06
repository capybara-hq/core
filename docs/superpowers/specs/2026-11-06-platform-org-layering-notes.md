# Platform / org layering: decisions so far (design A, not yet written)

Status: notes, 2026-11-06. Brainstorming record, not a design. The design is written only after the
`docs/plugin-component-management` branch (spec `2026-11-05-plugin-component-management-design.md`,
phases 1-4) has finished and merged, because A changes the same things (enabled set, org config,
settings pages, scope) and extends that spec. The model platform providers design
(`2026-11-06-model-platform-providers-design.md`) follows A.

Terms follow the plugin-component-management spec §13.4b / §13.4c: **platform** = the deployment
layer, run by the **super admin**; **org admin** runs an org.

## Principle (decided by the maintainer)

This is an architecture rule for every extension point, not a model-specific one.

- **Platform (super admin)** decides whether a capability exists and what its defaults are:
  install, review (permission approval), enable on the platform, default / fallback config, and the
  confirmation of anything shared between orgs.
- **Org admin** is the primary controller of everything inside the org, within what the platform
  offers: it can turn off an extension the platform enabled (e.g. jina), turn off a single tool,
  and override any config.

## Decisions

1. **Scope `all` (全部组织启用) changes**: on by default in every org, and an org admin **may turn it
   off**. Only built-in (bootstrap required) plugins stay forced on. This amends the
   plugin-component-management spec §5, where `all` cannot be turned off by orgs.
2. **One form, two levels**: the platform and an org see a similar config form for the same
   extension. Example: the platform configures `openai-compatible` with two models and a key; an org
   can edit the model list (add, remove), the endpoint and the key for itself.
3. **Platform values are the default**: the org form shows the platform's values marked as
   "platform configured", and says that an edit overrides them for this org only and does not affect
   other orgs.
4. **Copy on edit, whole config, no sync**: until an org edits anything it follows the platform
   config entirely. The first org edit copies the platform config **whole** (changing the endpoint
   usually means its own key and model list too) and from then on the copy is the org's own: later
   platform changes do not flow into it (e.g. a model the platform adds later does not appear).
5. **Diff and take**: an org can see the difference between its copy and the platform's current
   config and choose which platform values to take over.
6. **Model providers and connectors**, deployment-level only today, come under the same rule (org
   can turn them off, use its own key, choose models).
7. **Per-org tool switch**: an org can turn off single tools of an enabled extension.

## Open

- Claude's suggestion, not confirmed: a "go back to following the platform" action that drops the
  org's copy.
- Which config fields an extension may mark platform-only (e.g. a value the org must never change),
  if any.
- What "sharing confirmed by the platform" covers beyond the plugin-component-management phase 3
  sharing (可共享).

## Current state (2026-11-06, `main`)

- Extensions have a deployment config (`ctx.config`) and an org config (`orgConfig`) with separate
  schemas; an org config never falls back to the deployment config (jina's key is org-only).
- Tool extensions need an org switch; model providers and connectors are deployment-wide
  (`ProviderRegistry` has no org dimension; `model-provider@2` calls carry no org).
- `web-search@1` / `web-fetch@1` pass the org's decrypted `orgConfig` into each call and use
  `configured(orgConfig)`: the pattern for an org-aware provider call.
