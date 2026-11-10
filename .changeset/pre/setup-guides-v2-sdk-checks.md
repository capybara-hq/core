---
"@capybara-hq/plugin-sdk": minor
---

Setup checks contract: an extension registers the live rows of its setup guides with
`ctx.setup.check(id, { place, run })` during `setup`, each id listed in the new
`permissions.setupChecks` (`SETUP_CHECK_ID_RE`, at most 32; ids with `:` stay the kernel's).
`run` gets the org, the extension's effective config, the locale, the mode, an abort signal and the
target: a channel connection with its config, or a connector with its ids and OAuth client id
(never the client secret or a member's token). Results are `ok` / `failing` / `unknown` with plain
text `reason` and `fix` (en required, zh optional, 300 / 500 characters) and no details field;
`validateSetupCheckResult` returns a fresh copy or why it is invalid. `SETUP_CHECK_LIMITS` holds
the run limits. A check never writes, passes `signal` on, does not retry and never puts a secret
in its result.
