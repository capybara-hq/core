# Authoring: extension point sandbox

<!-- generated:extension-point -->
- Name: `sandbox` (a ref is `sandbox@<major>`)
- Runs a device's instance and keeps its files for agents' commands (Docker, E2B).
- Providers: one at a time
- Enabled per org: no
- Brokered by the platform: yes (extensions use it only through `ctx`)
<!-- /generated -->

Contract: SandboxProvider (`sandbox.ts`)

The kernel accepts only `sandbox@2`. An environment is one instance plus a file system that outlives it. Implement the file system (`createFileSystem`, `destroyFileSystem`, `destroyFileSystemByName`), the instance on it (`create`, which throws `FileSystemGoneError` when the file system is gone instead of making an empty one; `resume`, `suspend`; `destroy` and `destroyByName`, which drop the instance and keep the files), and the instance's `exec`, `readFile`, `writeFile`, `stat`, `killAll` and `killTagged` (`concurrentExec` is required: several conversations share one instance). Aborting a command must kill it. Locking, suspension timing and destruction are the kernel's job, not yours. Never publish a docker socket proxy on a host address.

See `extensions` for the rules every extension follows.
