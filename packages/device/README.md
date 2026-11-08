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
