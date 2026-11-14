---
"@capybara-hq/kernel": patch
---

The command review closes routes its rule table let through. Inline interpreter code (`python -c`,
`node -e`, `perl -e`, `deno eval`, …), code fed to an interpreter on stdin or from a URL, packages a
runner fetches (`npx`, `pnpm dlx`, `uvx`; known development tools stay allowed) and files the
conversation itself wrote are now `unsure` (the classifier decides, else the person is asked).
Destroying `/`, the home directory or a parent of the workspace is denied for every program —
`mv`, `chmod -R`, `chown -R`, `find -delete`, `rsync --delete` as well as `rm`. Links to paths outside
the workspace ask, links to credentials ask every time. `gh api` writes ask. More credential files
are secret paths (`~/.npmrc`, `~/.pypirc`, `~/.vault-token`, shell history, …).

Session grants (「本会话允许同类」) now allow a line only when every class it asks about is granted
and nothing in it is unsure, are never consulted in unattended runs, and come in finer classes:
`ask.rc-files` splits into `ask.shell-config`, `ask.persistence`, `ask.ssh` and `ask.secret-file`,
and credential prints, credential links, dynamic arguments and `sudo` are asked every time. A
classifier allow on a command too long to read in full is an ask, and a command over the 32 KiB
ceiling is refused before review.
