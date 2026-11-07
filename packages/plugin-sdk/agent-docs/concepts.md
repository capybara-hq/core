# Platform concepts

Read this first. It explains the vocabulary the other topics use.

## Platform and org

- The **platform** is one deployment. The **super admin** runs it: imports plugins into the
  **catalog**, decides where each item is on, and configures deployment-wide extensions.
- An **org** is a tenant of the platform. An org sees the platform items that are on in it, plus
  the items it owns. **Org admins** manage their org; **members** use it.
- Everything you do through the `Platform` tool acts as the person who started the run. You never
  have more rights than that person, and role, membership and super admin status are re-read on
  every call.

## Plugins, extensions, skills, templates

- A **plugin** is the install and distribution unit: an optional extension, skills, connector
  templates and agent templates (see `plugin-format`).
- An **extension** is the in-process code inside a plugin (see `extensions`). Most
  contributions need no code: a plugin with only skills or templates is *declarative*.
- A **skill** is instructions the agent loads on demand (`skills`). An **agent template**
  describes a whole agent (`agent-templates`). A **connector template** is a ready-made
  connection to an external system (`connector-templates`).
- An **extension point** is a versioned contract (`channel@1`) an extension provides or consumes.

## Scope

Every platform item (plugin, and its skills and templates) has a scope:

| Scope | Meaning |
|---|---|
| `all` | On in every org. Org admins cannot switch it. |
| `optional` | Off until an org admin switches it on. The default for new imports. |
| `named` | On in the listed orgs only; invisible to other orgs unless shown to them. |

Skills, agent templates and connector templates of a platform plugin are platform components: one
version per deployment, never copied into orgs.

## Owner and shareable

An item has an owner: the platform (no owner org) or one org. An org-owned item reaches another org
only if its owner marked it `shareable` and the platform then shows or scopes it there.

## Requests

When a person cannot do something themselves (install a plugin that is not on in their org,
approve extension permissions), they file a **request**. Org admins or the super admin decide it
on the web. Agents can file requests but never decide them.

## Sandbox

Agents run commands and keep files in a **sandbox**, one per conversation. Skills are mounted
read-only under `/skills/<name>/`. Sandbox limits and network egress are set per org by admins.

## What agents may not do

Deciding approvals and requests, confirming extension permissions, managing tokens and secrets,
changing roles. Operations that need credentials refuse and point to the web page.
