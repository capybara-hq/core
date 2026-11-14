---
"@capybara-hq/device": patch
---

The login service tells the truth. Exit 0 now means a deliberate stop (logout, a revoked
credential, drain, not logged in) and the macOS agent restarts only failing exits (`KeepAlive {
SuccessfulExit: false }`); a deployment that needs a newer program (426) exits 1, so an upgrade in
place recovers. `stop` refuses only when the service runs the program it would signal, `service
start` refuses next to a terminal program, and a pid file is trusted only when `ps` shows this
program started before it. `service status` separates not installed, not loaded, exited (see
`service.log`) and running, and compares with the package the service file runs; `service
stop|restart` report a service that stayed loaded or did not come back. The policy summary reports
the owner's mode, file operations without the OS sandbox wait for a fresh command decision, and
`login` checks the OS sandbox before writing a sandbox policy and words its lines for Docker.
