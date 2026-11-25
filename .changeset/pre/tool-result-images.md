---
"@capybara-hq/kernel": patch
"@capybara-hq/design": patch
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/capybara": patch
---

Images in tool results reach the agent and the person. The pipeline stores every image block a
tool returns (a browser screenshot, an MCP image) as a copy of the conversation and names it in the
result (`file_id`); a model with vision sees it after the step's results, a model without vision is
told it was not shown and how to read it, and an image that cannot be stored says why. The web
shows the images as thumbnails on the call's row (opening the image viewer), and `Deliver` takes a
`file_id` to hand such an image (or any attachment or artifact of the conversation) to the person
without a device.
