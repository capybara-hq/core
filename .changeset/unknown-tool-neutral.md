---
"@capybara-hq/kernel": patch
---

In ToolSearch mode, a call to a tool name the model has not loaded, such as a miscased catalog
key, shows as the neutral "load the tool first" notice instead of a failure. The model still gets
the same error text.
