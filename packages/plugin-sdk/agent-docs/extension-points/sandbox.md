# Extension point: sandbox

<!-- generated:extension-point -->
- Name: `sandbox` (a ref is `sandbox@<major>`)
- Runs an agent's commands and files in an isolated environment (Docker, E2B).
- Providers: one at a time
- Enabled per org: no
- Brokered by the platform: yes (extensions use it only through `ctx`)
<!-- /generated -->

Contract: SandboxProvider (`sandbox.ts`)

Implement `create`, `resume`, `suspend`, `destroy` and the instance's `exec`, `readFile`, `writeFile`, `stat`. Aborting a command must kill it. Locking, suspension timing and destruction are the kernel's job, not yours. Never publish a docker socket proxy on a host address.

See `extensions` for the rules every extension follows.
