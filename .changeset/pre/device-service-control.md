---
"@capybara-hq/device": minor
---

`capybara-device service start|stop|restart` control the login service without knowing launchctl or
systemctl, and `service status` now names the version the running program uses: when it is older
than the installed package (a daemon left over from before an upgrade) the third line says
`installed <v> — restart it: capybara-device service restart`. `stop` unloads the service instead of
signalling a program the restart policy would bring back, so the top-level `stop` now refuses while
a login service is installed. The pid file records the running version (`{pid, version,
startedAt}`); one written by an older program reads as version unknown.
