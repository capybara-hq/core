# Authoring: extension point device-provider

<!-- generated:extension-point -->
- Name: `device-provider` (a ref is `device-provider@<major>`)
- Provides devices (an instance plus kept files) agents run commands in: containers, microVMs, connected machines.
- Providers: several
- Enabled per org: yes
- Brokered by the platform: yes (extensions use it only through `ctx`)
<!-- /generated -->

Contract: DeviceProvider (`device-provider.ts`)

The kernel accepts `device-provider@1`; several providers may be loaded side by side and each device keeps the provider that made it. A device is one instance plus a file system that outlives it. Implement the file system (`createFileSystem`, `destroyFileSystem`, `destroyFileSystemByName`), the instance on it (`create`, which throws `FileSystemGoneError` when the file system is gone instead of making an empty one; `resume`, `suspend`; `destroy` and `destroyByName`, which drop the instance and keep the files), and the instance's `exec`, `readFile`, `writeFile`, `stat`, `killAll` and `killTagged` (`concurrentExec` is required: several conversations share one instance). Aborting a command must kill it. Locking, suspension timing and destruction are the kernel's job, not yours.

See `extensions` for the rules every extension follows.
