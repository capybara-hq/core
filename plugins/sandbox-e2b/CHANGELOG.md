# @capybara-hq/plugin-sandbox-e2b

## 0.1.1

### Patch Changes

- 7f9627d: The Docker and E2B sandbox plugins declare concurrent exec: commands carry their holder's tag and
  `killTagged` kills one holder's commands. Starting a stopped instance tolerates concurrent calls.
  When a tagged kill is not possible and the provider falls back to a restart, the commands of the
  other holders end too (it is logged).
- Updated dependencies [89b4521]
- Updated dependencies [c2c826b]
- Updated dependencies [9a5a340]
- Updated dependencies [7f9627d]
- Updated dependencies [85d8d40]
- Updated dependencies [e07bdd4]
- Updated dependencies [b50154b]
- Updated dependencies [21b1385]
  - @capybara-hq/plugin-sdk@0.2.0
