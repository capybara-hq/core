---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

Org readiness agrees with the agent form: the model step is ready only when the org has a chat
model an agent can pick (the same cached lists and time limit as the agent form's model list).
Providers that are on but give no model make the new state `no_models`, with each provider and
why (its list failed, with the error kind such as `auth`, or it has no chat model on in the org).
The setup checklist names the provider and the problem and links to `/admin/models` or
`/settings/models`; the agent form says the configured model services list no usable model
instead of asking to install a provider.
