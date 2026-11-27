---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A model step cut off at the output token limit no longer ends the run as completed: request
building tells the model right after the cut-off reply that it was truncated and an unfinished
tool call did not run, and the run gets another step. After three truncated steps in a row the run
ends with the new reason `max_output`; the web shows runs that ended at a limit with a warning
instead of "Done" (#951).
