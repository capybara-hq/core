# 创建 fake IM 应用

打开 fake 平台控制台，用下面的 manifest 创建应用。

::: mode long_connection
```yaml title="应用 manifest（长连接）"
# The fake IM app for "{{connectionName}}" ({{orgName}}), fake-im {{pluginVersion}}.
app:
  name: "{{connectionName}}"
  long_connection: true
  sign_in_redirect: "{{signInCallbackUrl}}"
```
:::

::: mode webhook
```json title="应用 manifest（webhook）"
{
  "app": {
    "name": "{{connectionName}}",
    "long_connection": false,
    "request_url": "{{webhookUrl}}",
    "sign_in_redirect": "{{signInCallbackUrl}}"
  }
}
```

平台把事件发到 `{{webhookUrl}}`。
:::
