# Create the demo app

Org {{orgName}}, plugin {{pluginName}} {{pluginVersion}}, mode {{mode}}.

## 1. Create the app from the manifest

::: mode long_connection
```yaml title="App manifest (long connection)"
display_information:
  name: "{{connectionName}}"
settings:
  socket_mode_enabled: true
# {{ publicUrl }}
```
:::

::: mode webhook
```yaml title="App manifest (webhook)"
display_information:
  name: "{{connectionName}}"
settings:
  event_subscriptions:
    request_url: "{{webhookUrl}}"
oauth_config:
  redirect_urls:
    - "{{signInCallbackUrl}}"
```

The platform posts events to {{webhookUrl}}.
:::

## 2. Copy the bot token

Paste the bot token into the Bot token field.

::check bot-token Bot token works
::check capybara:public-url Public URL is set
