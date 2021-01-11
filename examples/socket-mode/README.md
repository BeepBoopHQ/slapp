# Bolt-js Socket Mode Test App

This is a quick example app to test [Socket Mode](https://api.slack.com/socket-mode) with bolt-js.

If using OAuth, local development requires a public URL where Slack can send requests. In this guide, we'll be using [`ngrok`](https://ngrok.com/download). Checkout [this guide](https://api.slack.com/tutorials/tunneling-with-ngrok) for setting it up. OAuth installation is only needed for public distribution. For internal apps, we recommend installing via your app config. 

Before we get started, make sure you have a development workspace where you have permissions to install apps. If you don’t have one setup, go ahead and [create one](https://slack.com/create). You also need to [create a new app](https://api.slack.com/apps?new_app=1) if you haven’t already. You will need to enable Socket Mode and generate an App Level Token. 

## Install Dependencies

```
npm install
```

## Install app to workspace

In your [**App Config** Page](https://api.slack.com/apps), go to **OAuth & Permissions** and add the `channels:read`, `app_mentions:read`, `commands` and `chat:write` permissions. Click **install App** to install the app to your workspace and generate a bot token.

Then go to the **Socket Mode** section in App Config to enable it.

Go to **Basic Information** section in App Config and generate a `App Level Token` with the `connections:write` scope.

Navigate to the **App Home** page in your app config and enable it.

Lastly, in the **Events Subscription** page, click **Subscribe to bot events** and add `app_home_opened`, `app_mentioned`, and `message.channels`.

## Setup Environment Variables

This app requires you setup a few environment variables. You can get these values by navigating to your [**App Config** Page](https://api.slack.com/apps). 

```
// can get this from OAuth & Permission page in app config
export BOT_TOKEN=YOUR_SLACK_BOT_TOKEN
// can generate the app token from basic information page in app config
export APP_TOKEN=YOUR_SLACK_APP_TOKEN 

// if using OAuth, also export the following
export CLIENT_ID=YOUR_SLACK_CLIENT_ID
export CLIENT_SECRET=YOUR_SLACK_CLIENT_SECRET
```

## Run the App

Start the app with the following command:

```
npm start
```

### Running with OAuth

Only implement OAuth if you plan to distribute your application publicly. Uncomment out the OAuth specific comments in the code. If you are on dev instance, you will have to uncomment out those options as well. 

Start `ngrok` so we can access the app on an external network and create a `redirect url` for OAuth. 

```
ngrok http 3000
```

This should output a forwarding address for `http` and `https`. Take note of the `https` one. It should look something like the following:

```
Forwarding   https://3cb89939.ngrok.io -> http://localhost:3000
```

Then navigate to **OAuth & Permissions** in your App Config and add a Redirect Url. The redirect URL should be set to your `ngrok` forwarding address with the `slack/oauth_redirect` path appended. ex:

```
https://3cb89939.ngrok.io/slack/oauth_redirect
```
