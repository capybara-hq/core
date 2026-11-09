# Create the fake IM app

Open the fake platform console and create an app from the manifest below.

::: mode long_connection

```yaml title="App manifest"
# The fake IM app, fake-im {{pluginVersion}}.
app:
  name: "{{connectionName}}"
  long_connection: true
  sign_in_redirect: "{{signInCallbackUrl}}"
```

:::

::: mode webhook

The platform posts events to `{{webhookUrl}}`.

```json title="App manifest"
{
  "app": {
    "name": "{{connectionName}}",
    "long_connection": false,
    "request_url": "{{webhookUrl}}",
    "sign_in_redirect": "{{signInCallbackUrl}}"
  }
}
```

:::
