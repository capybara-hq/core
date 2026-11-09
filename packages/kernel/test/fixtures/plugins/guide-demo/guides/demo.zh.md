# 创建演示应用

组织 {{orgName}}，插件 {{pluginName}} {{pluginVersion}}，模式 {{mode}}。

## 1. 用 manifest 创建应用

::: mode long_connection
```yaml title="应用 manifest（长连接）"
display_information:
  name: "{{connectionName}}"
settings:
  socket_mode_enabled: true
# {{ publicUrl }}
```
:::

::: mode webhook
```yaml title="应用 manifest（webhook）"
display_information:
  name: "{{connectionName}}"
settings:
  event_subscriptions:
    request_url: "{{webhookUrl}}"
oauth_config:
  redirect_urls:
    - "{{signInCallbackUrl}}"
```

平台把事件发到 {{webhookUrl}}。
:::

## 2. 复制机器人令牌

把机器人令牌粘贴到「Bot token」字段。

::check bot-token 机器人令牌可用
::check capybara:public-url 已设置公网地址
