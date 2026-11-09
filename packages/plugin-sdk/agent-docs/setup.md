# Helping with plugin setup

Read this before helping a person set up a channel connection or a connector from a plugin's
setup guide. The `setup` operations do the reading and checking; everything that needs a secret or
the person's own decision stays with the person on the web.

## The flow

1. **List** the guides you may help with: `call setup.guides`. Each guide has its targets (a
   channel connection, a connector made from a template, or a template switched on without a
   connector yet), a drift entry when the plugin changed the guide since the target was set up, a
   count of the cached check states, and the `webPath` of the page where the person does the
   setup. Org admins get the admin guides; members get the guides for connecting their own
   account (audience `member`).
2. **Read** the guide for the target: `call setup.read` with `itemId`, `guideId` and the target
   (`connectionId` for a channel guide, `connectorId` for a connector template guide; `audience`
   `member` for a member guide). It returns the guide as Markdown, with each check as a
   `- [check <id>] <label>` line, the modes (for example `long_connection` or `webhook`), the
   variables that have no value yet with the reason, and the `webPath`.
3. **Explain the step the person is on**, in their language: what to open at the third-party
   platform, what to paste there (the app manifest and URLs come from the guide), what to copy
   back.
4. **Run a check after the person says they did a step**: `call setup.check` with the check id
   from the guide. A fresh cached result comes back as is; `force: true` reruns it, at most once
   every 10 seconds per check and target. `call setup.status` reads every check's cached state
   without running anything.
5. **Explain a failing check** with its `reason` and `fix`, then wait for the person to fix it and
   say so before running it again. `running` means another run is in progress: read the state
   again in a moment. `unknown` means the check could not answer; its reason says why.

## What stays with the person

- **Secrets.** Bot tokens, app tokens, signing secrets and OAuth client secrets are typed by the
  person into their fields on the `webPath` page. Never ask for a secret in the conversation and
  never repeat one; if the person pastes one anyway, tell them to rotate it at the third-party
  platform. The guide and the check results never contain secret values, and no setup operation
  takes one.
- **Connecting a personal account** (OAuth consent) happens in the browser on the connector page.
- **Confirming the app was updated** after a guide changed (the drift notice) is the person's
  click on the target's page: only they know they changed the app at the third party.
- **Creating the app** at the third-party platform is outside Capybara: explain it, the person
  does it.

Switching a channel connection's inbound mode is an ordinary confirmed operation
(`channels.update`); the person approves the card.
