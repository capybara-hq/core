---
"@capybara-hq/testing": patch
---

`startFakeGitServer` spawns git less: a commit is one `git fast-import` (it was five or more git
commands), and a ref advertisement is answered by `git http-backend` once per repository state and
repeated until the next commit. Every answer still comes from git.
