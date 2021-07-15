---
title: Reference
order: 1
slug: reference
lang: en
layout: fullpage
permalink: /reference
---
# App interface and configuration

<div class="section-content">
This guide is intended to detail the Bolt interface–including listeners and their arguments, initialization options, and errors. It may be helpful to first go through the ⚡️[Getting Started guide](/bolt-js/tutorial/getting-started) to learn the basics of building Bolt for JavaScript apps.
</div> 

- [Listener functions](#listener-functions)
  - [Methods](#methods)
  - [Function arguments](#listener-function-arguments)
  - [Difference from listener middleware](#difference-from-listener-middleware)
- [Initialization options](#initialization-options)
  - [Receiver options](#receiver-options)
  - [App options](#app-options)
- [Error types](#framework-error-types)
  - [Client errors](#client-errors)

---

## Listener functions
Slack apps typically receive and/or respond to one to many incoming events from Slack. This can be something like listening to an Events API event (like when a link associated with your app is shared) or a user invoking one of your app's shortcuts. For each type of incoming request from Slack, there are distinct methods that you can pass **listener functions** to handle and respond to the event.

<div class="method-content">
### Methods
Below is the current list of methods that accept listener functions. These methods handle specific event types coming from Slack, and typically include an identifing parameter before the listener function. The identifying parameter (included below) narrows the events to specific interactions that your listener function is intended to handle, such as a specific `callback_id`, or a certain substring within a message.

| Method                          | Description |
|--------------------------------------------------------------------|
| `app.event(eventType, fn);`     | Listens for Events API events. The `eventType` is a `string` to identify a [specific event](https://api.slack.com/events) to handle (which must be subscribed to in your app's configuration).   | 
| `app.message([pattern ,] fn);`  | Convenience method to listen specifically to the [`message` event](https://api.slack.com/events/message). The pattern parameter can be any substring (`string`) or `RegExp` expression, which will be used to identify the incoming message. | 
| `app.action(actionId, fn);`     | Listens for an action event from a Block Kit element, such as a user interaction with a button, select menu, or datepicker. The `actionId` identifier is a `string` that should match the unique `action_id` included when your app sends the element to a view. Note that a view can be a message, modal, or app home. Note that action elements included in an `input` block do not trigger any events.
| `app.shortcut(callbackId, fn);` | Listens for global or message shortcut invocation. The `callbackId` is a `string` or `RegExp` that must match a shortcut `callback_id` specified within your app's configuration.
| `app.view(callbackId, fn);`     | Listens for `view_submission` and `view_closed` events. `view_submission` events are sent when a user submits a modal that your app opened. `view_closed` events are sent when a user closes the modal rather than submits it.
| `app.step(workflowStep)` | Listen and responds to workflow step events using the callbacks passed in an instance of `WorkflowStep`. Callbacks include three callbacks: `edit`, `save`, and `execute`. More information on workflow steps can be found [in the documentation](/bolt-js/concepts#adding-editing-steps).
| `app.command(commandName, fn);` | Listens for slash command invocations. The `commandName` is a `string` that must match a slash command specified in your app's configuration. Slash command names should be prefaced with a `/` (ex: `/helpdesk`).
| `app.options(actionId, fn);`    | Listens for options requests (from select menus with an external data source). This isn't often used, and shouldn't be mistaken with `app.action`. The `actionId` identifier is a `string` that matches the unique `action_id` included when you app sends a [select with an external data source](https://api.slack.com/reference/block-kit/block-elements#external_select).

#### Constraint objects
There are a collection of constraint objects that some methods have access to. These can be used to narrow the event your listener function handles, or to handle special cases. Constraint objects can be passed in lieu of the identifiers outlined above. Below is a collection of constraint objects and the methods they can be passed to. 

| Method                                         | Options | Details |
|--------------------------------------------------------------------|
| `app.action(constraints, fn)` | `block_id`, `action_id`, `callback_id`, (,`type`) | Listens for more than just the `action_id`. `block_id` is the ID for the element's parent block. `callback_id` is the ID of the view that is passed when instantiating it (only used when action elements are in modals). To specifically handle an action element in blocks or in legacy attachments, you can use `type` with the value of `block_actions` or `interactive_message` respectively. |
| `app.shortcut(constraints, fn)` | `type`, `callback_id` | Allows specification of the type of shortcut. `type` must either be `shortcut` for **global shortcuts** or `message_action` for **message_shortcuts**. `callbackId` can be a `string` or `RegExp`. |
| `app.view(constraints, fn)` | `type`, `callback_id` | `type` must either be `view_closed` or `view_submission`, which determines what specific event your listener function is sent. `callback_id` is the `callback_id` of the view that is sent when your app opens the modal. |
| `app.options(constraints, fn)` | `block_id`, `action_id`, `callback_id` | Optionally listens for `block_id` and `callback_id` in addition to `action_id`. `callback_id` can only be passed when handling options elements within modals. |

</div>

### Listener function arguments
Listener functions have access to a set of arguments that may change based on the method which the function is passed to. Below is an explanation of the different arguments. The below table details the different arguments and the methods they'll be accessible in.

| Argument  | Description  |
| :---: | :--- |
| `payload` | All listeners | The unwrapped contents of the incoming event, which varies based on event. This is a subset of the information included in `body` which is detailed below. `payload` is also accessible via the alias corresponding to the method name that the lisener is passed to (`message`, `event`, `action`, `shortcut`, `view`, `command`, `options`) **An easy way to understand what's in a payload is to log it**, or [use TypeScript](/bolt-js/tutorial/using-typescript). |
| `say` | `message`, `event`, `action` `command` | Function to send a message to the channel associated with the incoming event. This argument is only available when the listener is triggered for events that contain a channel ID (the most common being `message` events). `say` accepts simple strings (for plain-text messages) and objects (for messages containing blocks). `say` returns a promise that will resolve with a [`chat.postMessage` response](https://api.slack.com/methods/chat.postMessage). If you're using an the `action` method, or an event other than `message`, you should [ensure that the event payload contains a channel ID](https://api.slack.com/events).
| `ack` | `action`, `shortcut`, `view`, `command`, `options` | Function that **must** be called to acknowledge that an incoming event was received by your app. `ack` returns a promise that resolves when complete. Read more in [Acknowledging events](#acknowledging-events)
| `client` | All listeners | Web API client that uses the token associated with that event. For single-workspace installations, the token is provided to the constructor. For multi-workspace installations, the token is returned by the `authorize` function.
| `respond` | `shortcut`, `action`, `command` | Function that responds to an incoming event **if** it contains a `response_url`. `respond` returns a promise that resolves with the results of responding using the `response_url`. For shortcuts, `respond` will **only** work for message shortcuts (not global shortcuts).
| `context` | All listeners | Event context. This object contains data about the event and the app, such as the `botId`. Middleware can add additional context before the event is passed to listeners.
| `body` | All listeners | Object that contains the entire body of the request (superset of `payload`). Some accessory data is only available outside of the payload (such as `trigger_id` and `authorizations`).

#### Body and payload references
The structure of the `payload` and `body` is detailed on the API site:
- `action`: [`body`](https://api.slack.com/reference/interaction-payloads/block-actions) and [`payload`s](https://api.slack.com/reference/block-kit/block-elements)
- `event`: [`body`](https://api.slack.com/types/event) and [`payload`s](https://api.slack.com/events)
- `shortcut`: [`body` and `payload`](https://api.slack.com/reference/interaction-payloads/shortcuts)
- `command`: [`body` ](https://api.slack.com/interactivity/slash-commands)
- `view`: [`view_submission` `body` and `payload`](https://api.slack.com/reference/interaction-payloads/views#view_submission); [`view_closed` `body` and `payload`](https://api.slack.com/reference/interaction-payloads/views#view_closed)
- `options`: [`body` and `payload`](https://api.slack.com/reference/block-kit/block-elements#external_select)

### Difference from listener middleware
Listener middleware is used to implement logic across many listener functions (though usually not all of them). Listener middleware has the same arguments as the above listener functions, with one distinction: they also have a `next()` function that **must** be called in order to pass the chain of execution. Learn more about listener middleware [in the documentation](/bolt-js/concepts#listener-middleware).

## Initialization options
Bolt includes a collection of initialization options to customize apps. There are two primary kinds of options: Bolt app options and receiver options. The receiver options may change based on the receiver your app uses. The following receiver options are for the default `HTTPReceiver` (so they'll work as long as you aren't using a custom receiver).

### Receiver options
`HTTPReceiver` options can be passed into the `App` constructor, just like the Bolt app options. They'll be passed to the `HTTPReceiver` instance upon initialization.

| Option  | Description  |
| :---: | :--- |
| `signingSecret` | A `string` from your app's configuration (under "Basic Information") which verifies that incoming events are coming from Slack |
| `endpoints` | A `string` or `object` that specifies the endpoint(s) that the receiver will listen for incoming requests from Slack. Currently, the only key for the object is `key`, the value of which is the customizable endpoint (ex: `/myapp/events`). **By default, all events are sent to the `/slack/events` endpoint** |
| `processBeforeResponse` | `boolean` that determines whether events should be immediately acknowledged. This is primarily useful when running apps on FaaS to ensure events listeners don't unexpectedly terminate by setting it to `true`. Defaults to `false`.  |
| `clientId` | The client ID `string` from your app's configuration which is [required to configure OAuth](/bolt-js/concepts#authenticating-oauth). |
| `clientSecret` | The client secret `string` from your app's configuration which is [required to configure OAuth](/bolt-js/concepts#authenticating-oauth). |
| `stateSecret` | Recommended parameter (`string`) that's passed when [configuring OAuth](/bolt-js/concepts#authenticating-oauth) to prevent CSRF attacks |
| `installationStore` | Defines how to save, fetch and delete installation data when [configuring OAuth](/bolt-js/concepts#authenticating-oauth). Contains three methods: `fetchInstallation`, `storeInstallation` and `deleteInstallation`. The default `installationStore` is an in-memory store. |
| `scopes` | Array of scopes that your app will request [within the OAuth process](/bolt-js/concepts#authenticating-oauth). |
| `installerOptions` | Optional object that can be used to customize [the default OAuth support](/bolt-js/concepts#authenticating-oauth). Read more in the OAuth documentation. |

### App options
App options are passed into the `App` constructor.

| Option  | Description  |
| :---: | :--- |
| `receiver` | An instance of `Receiver` that parses and handles incoming events. Must conform to the [`Receiver` interface](/bolt-js/concepts#receiver), which includes `init(app)`, `start()`, and `stop()`. More information about receivers is [in the documentation](/bolt-js/concepts#receiver). |
| `agent` | Optional HTTP `Agent` used to set up proxy support. Read more about custom agents in the [Node Slack SDK documentation](https://slack.dev/node-slack-sdk/web-api#proxy-requests-with-a-custom-agent). |
| `clientTls` |  Optional `string` to set a custom TLS configuration for HTTP client requests. Must be one of: `"pfx"`, `"key"`, `"passphrase"`, `"cert"`, or `"ca"`. |
| `convoStore` | A store to set and retrieve state-related conversation information. `set()` sets conversation state and `get()` fetches it. By default, apps have access to an in-memory store. More information and an example can be found [in the documentation](/bolt-js/concepts#conversation-store). |
| `token` | A `string` from your app's configuration (under "Settings" > "Install App") required for calling the Web API. May not be passed when using `authorize`, `orgAuthorize`, or OAuth. |
| `botId` | Can only be used when `authorize` is not defined. The optional `botId` is the ID for your bot token (ex: `B12345`) which can be used to ignore messages sent by your app. If a `xoxb-` token is passed to your app, this value will automatically be retrieved by your app calling the [`auth.test` method](https://api.slack.com/methods/auth.test). |
| `botUserId` | Can only be used wihen `authorize` is not defined. The optional `botUserId` is distinct from the `botId`, as it's the user ID associated with your bot user used to identify direct mentions. If a `xoxb-` token is passed to your app, this value will automatically be retrieved by your app calling the [`auth.test` method](https://api.slack.com/methods/auth.test). |
| `authorize` | Function for multi-team installations that determines which token is associated with the incoming event. The `authorize` function is passed source data that sometimes contains a `userId`, `conversationId`, `enterpriseId`, `teamId` and `isEnterpriseInstall` (depending which information the incoming event contains). An `authorize` function should either return a `botToken`, `botId`, and `botUserId`, or could return a `userToken`. If using [built-in OAuth support](/bolt-js/concepts#authenticating-oauth), an `authorize` function will automatically be created so you do not need to pass one in. More information about `authorization` functions can be found on   |
| `logger` | Option that allows you to pass a custom logger rather than using the built-in one. Loggers must implement specific methods ([the `Logger` interface](https://github.com/slackapi/node-slack-sdk/blob/main/packages/logger/src/index.ts)), which includes `setLevel(level: LogLevel)`, `getLevel()`, `setName(name: string)`, `debug(...msgs: any[])`, `info(...msgs: any[])`, `warn(...msgs: any[])`, and `error(...msgs: any[])`. More information about logging are [in the documentation](/bolt-js/concepts#logging)  |
| `logLevel` | Option to control how much or what kind of information is logged. The `LogLevel` export contains the possible levels–in order of most to least information: `DEBUG`, `INFO`, `WARN`, and `ERROR`. By default, `logLevel` is set to `INFO`. More information on logging can be found [in the documentation](/bolt-js/concepts#logging). |
| `ignoreSelf` | `boolean` to enable a middleware function that ignores any messages coming from your app. Requires a `botId`. Defaults to `true`.  |
| `clientOptions.slackApiUrl` | Allows setting a custom endpoint for the Slack API. Used most often for testing. | 

> Bolt's client is an instance of `WebClient` from the [Node Slack SDK](/node-slack-sdk), so some of that documentation may be helpful as you're developing.

## Framework error types
Bolt includes a set of error types to make errors easier to handle, with more specific contextual information. Below is a non-exhaustive list of error codes you may run into during development:

| Error code                         | Details |
|--------------------------------------------------------------------|
| `AppInitializationError` | Invalid initialization options were passed. This could include not passing a signing secret, or passing in conflicting options (for example, you can't pass in both `token` and `authorize`). Includes an `original` property with more details. This error is only thrown during initialization (within the App's constructor). |
| `AuthorizationError` | Error exclusively thrown when installation information can't be fetched or parsed. You may encounter this error when using the built-in OAuth support, or you may want to import and use this error when building your own `authorize` function. |
| `ContextMissingPropertyError` | Error thrown when the `context` object is missing necessary information, such as not including `botUserId` or `botId` when `ignoreSelf` is set to `true`. The missing property is available in the `missingProperty` property. |
| `ReceiverMultipleAckError` | Error thrown within Receiver when your app calls `ack()` when that request has previously been acknowledged. Currently only used in the default `HTTPReceiver`. |
| `ReceiverAuthenticityError` | Error thrown when your app's request signature could not be verified. The error includes information on why it failed, such as an invalid timestamp, missing headers, or invalid signing secret.
| `MultipleListenerError` | Thrown when multiple errors occur when processing multiple listeners for a single event. Includes an `originals` property with an array of the individual errors. |
| `WorkflowStepInitializationError` | Error thrown when configuration options are invalid or missing when instantiating a new `WorkflowStep` instance. This could be scenarios like not including a `callback_id`, or not including a configuration object. More information on Workflow Steps [can be found in the documentation](/concepts#steps).  |
| `UnknownError` | An error that was thrown inside the framework but does not have a specified error code. Contains an `original` property with more details. |

> You can read the code for error definition and construction [in errors.ts](https://github.com/slackapi/bolt-js/blob/main/src/errors.ts).

### Client errors
Bolt imports a `WebClient` to call Slack's APIs. Below is a set of errors you may encounter when making API calls with the client, though you can read more [in the web API documentation](/node-slack-sdk/web-api#handle-errors). When handling client errors, more information can be found in the body within the `data` property.

| Error code                         | Details |
|--------------------------------------------------------------------|
| `PlatformError` | Error received when calling a Slack API. Includes a `data` property. |
| `RequestError` | A request could not be sent, perhaps because your network connection is not available. It has an `original` property with more details. |
| `RateLimitedError` | Your app has made too many requests too quickly. Inclues a `retryAfter` property with the number of seconds you should wait before trying to send again. The `WebClient` will handle rate limit errors by default–[you can read more in the documentation](/node-slack-sdk/web-api#rate-limits). |
| `HTTPError` | The HTTP response contained an unfamiliar status code. The Web API only responds with `200` (including for errors), or `429` for rate limiting. |
