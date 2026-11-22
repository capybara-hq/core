---
"@capybara-hq/device": minor
---

Every command except `login` takes `--connection <selector>` / `-c <selector>` (a device id, device
name or host) and runs against that connection's directory; with one connection it is implied, with
several a command that needs one refuses and lists them. `logout -c` removes only that
connection's credential and login service (its policy, logs and working directory stay),
`service` acts on that connection's login service, and `start -c` of a connection that is not
logged in exits 0, which leaves its service stopped. `login` refuses a symlinked `connections/`
before creating anything, and never follows a symlinked `credential.json`.
