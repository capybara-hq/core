# @capybara-hq/device

`capybara-device` connects a laptop or server to a [Capybara](https://github.com/capybara-hq/core)
deployment as an environment: the platform's agents run commands and read and write files on this
machine, inside a sandbox, while the program is online.

Runs on macOS and Linux (on Windows use WSL or Docker). Node 22.12 or newer.

```bash
capybara-device login --url https://capybara.example.com   # approve in the browser
capybara-device status [--json]
capybara-device logout
```

Commands: `login --url <url> [--no-browser] [--dir <path>] [--mode os|docker]`, `logout`,
`status [--json]`, `start`, `stop`, `drain`, `policy [show|set <key> <value>]` and
`service install|uninstall`.

State lives in `$XDG_CONFIG_HOME/capybara-device` (default `~/.config/capybara-device`):
`credential.json` (mode 0600; the program refuses a file other users can read) and `policy.json`.
The working directory (default `~/capybara-device/<environmentId>`) holds `workspace/`, `skills/`
and `tmp/`.

In OS mode every command runs inside `@anthropic-ai/sandbox-runtime` (macOS Seatbelt, Linux
bubblewrap; Linux needs `bwrap` and `socat`): writes only under `workspace/` and `tmp/`,
`skills/` read only, `~/.ssh`, cloud CLI credentials, `~/.netrc`, `~/.gnupg`, browser profiles and
this program's state directory unreadable. Network is limited to the domains of the local policy
that the environment's egress also allows; with an empty policy (the default) commands reach no
network at all. Only you edit the policy, the platform can never widen it:

```bash
capybara-device policy set allowedDomains registry.npmjs.org,*.github.com
capybara-device policy show   # changes apply at the next start
```

Not enforced yet in OS mode: the `cpu` and `memoryMb` ceilings, and `allowCredentials` (commands
get no local credentials at all). Processes a command leaves running are killed with it by tag;
on macOS a child that leaves the command's process group and runs only Apple system binaries
cannot be found again (Linux runs each command in its own pid namespace, which takes every child
down with it).
