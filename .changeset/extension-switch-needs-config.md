---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

Switching on an extension whose org config has a required field that was never saved is refused
with the plain 400 `extension.config_invalid` and its field issues before the plugin installs
(no 502 `plugin.install_failed`); a `config` sent in the same PUT goes into the install. On the
扩展 page the switch of such an extension waits for the config (先填写组织级配置再启用), the
config form offers 保存并启用 (config and switch in one PUT), and a refused config marks the
form's fields.
