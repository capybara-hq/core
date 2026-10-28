---
"@capybara-hq/capybara": patch
---

`capybara` loads `.env` from the working directory before every command (variables already set in
the environment win); `--env-file <path>` loads another file and `--no-env-file` none.
