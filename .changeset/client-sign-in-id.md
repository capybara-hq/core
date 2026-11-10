---
"@capybara-hq/plugin-client": minor
"@capybara-hq/kernel": minor
"@capybara-hq/web": minor
---

Client code can do something once per sign-in: `useSignIn()` and `ClientApi.signIn` carry an
opaque id that stays the same for one sign-in and changes on the next one, different per plugin.
The kernel's client shell reads return it per item (`signInId`, a keyed hash of the session, never
the session id) and the web host hands it to plugins; the fake host takes `signInId`.
