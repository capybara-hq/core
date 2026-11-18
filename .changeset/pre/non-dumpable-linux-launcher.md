---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/testing": patch
---

The restricted Linux launcher (`linux-sandbox.py` in `SANDBOX_RUNTIME_SOURCE`) makes itself
non-dumpable (`PR_SET_DUMPABLE 0`) as its first statement, so a same-uid process outside the
operation (another session's Full-access work, with no Yama) can no longer ptrace the launcher,
supervisor or broker, nor read its `/proc/<pid>/mem`, `environ` or `fd`. A launcher already traced
at that point reports restricted unavailable. The restricted command stays dumpable after its own
execve (the broker reads its memory). The launcher digest changes, so consumers restage it.

The permission conformance gains an optional fixture hook, `inspect.outside(program, args)`, that
runs a program as the device user outside every operation; when present, the harness proves that
the parent of a restricted command refuses `PTRACE_ATTACH`, `mem` and `environ` to it.
