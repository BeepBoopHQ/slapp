---
title: リファレンス
order: 1
slug: reference
lang: ja-jp
layout: fullpage
permalink: /ja-jp/reference
---
# リファレンス（Appインターフェイスと設定）

<div class="section-content">
このガイドでは、Bolt インターフェイスのリスナー関数、リスナー関数の引数、初期化オプション、エラーについて詳しく説明します。⚡[入門ガイド](/bolt-js/ja-jp/tutorial/getting-started)をまだ完了していない場合は、先にそちらで Bolt for JavaScript アプリ開発の基本を確認しておきましょう。
</div>

- [リスナー関数](#listener-functions)
  - [メソッド](#methods)
  - [リスナー関数の引数](#listener-function-arguments)
  - [リスナーミドルウェアとの違い](#difference-from-listener-middleware)
- [初期化オプション](#initialization-options)
  - [レシーバーオプション](#receiver-options)
  - [Appオプション](#app-options)
- [エラーの種類](#framework-error-types)
  - [クライアント側のエラー](#client-errors)

---

## リスナー関数
Slack アプリは通常、Slack からのイベント情報を受け取ったり、それに応答を返したりします。受信するイベントは 1 つの場合もあれば、多数の場合もあります。例えば、Events API のイベント（アプリに関連するリンクが共有されたときなど）や、ユーザーがアプリのショートカットを実行するイベントを受け取ったりします。Slack からのリクエストの種類に応じて、それぞれ異なるメソッドが用意されています。これらのメソッドに、それらのイベントを処理したり応答を返したりするための**リスナー関数**を渡します。

<div class="method-content">
### メソッド
以下の表は、現在提供しているリスナー関数を渡すためのメソッドの一覧です。これらのメソッドを使って、Slack から送信された各種のイベントを処理します。各メソッドの一般的な設定は、まずイベントを判別するためのパラメーターがあり、リスナー関数がそれに続く形になっています。イベント判定のためのパラメーターとは、以下の説明にある、特定の `callback_id` やメッセージ中の部分一致の文字列を指定する部分などのことです。これにより、リスナー関数が処理するイベントを条件に合致するものだけに絞り込むことができます。

| メソッド                          | 説明 |
|--------------------------------------------------------------------|
| `app.event(eventType, fn);`     | Events API のイベントをリッスンします。`eventType` は、処理対象の[イベント](https://api.slack.com/events)を指定するための文字列 です。この値は、Slackアプリの設定画面でサブスクライブの設定がされている必要があります。   | 
| `app.message([pattern ,] fn);`  | [`message` イベント](https://api.slack.com/events/message)のリッスンに特化した、便利なメソッドです。`pattern` パラメーターには、部分一致させる文字列、または正規表現を指定します。これによって処理対象のメッセージを判別します。 | 
| `app.action(actionId, fn);`     | Block Kit エレメントから送信される `action` イベントをリッスンします。このイベントにはユーザーのボタン操作、メニュー選択、日付ピッカーの操作などがあります。`actionId` は文字列型で、アプリがビュー内に含めたブロックエレメントに指定した一意の `action_id` の値と一致する必要があります。ここでいう「ビュー」とは、メッセージ、モーダル、アプリのホームタブのことを指します。アクションエレメントを `input` ブロックに配置した場合はイベントがトリガーされないことに注意してください。
| `app.shortcut(callbackId, fn);` | グローバルショートカットまたはメッセージショートカットの呼び出しをリッスンします。`callbackId` は文字列または正規表現で、アプリの設定で指定したショートカットの `callback_id` にマッチする必要があります。
| `app.view(callbackId, fn);`     | `view_submission` イベントと `view_closed` イベントをリッスンします。`view_submission` イベントは、アプリが開いたモーダルでユーザーがデータ送信の操作をしたときに発生します。`view_closed` イベントは、ユーザーがデータ送信を実行せずにモーダルを閉じたときに発生します。
| `app.step(workflowStep)` | `WorkflowStep` のインスタンスに渡されたコールバックを使用して、ワークフローステップイベントのリッスンと応答を行います。コールバックには `edit`、`save`、`execute` の 3 種類があります。ワークフローステップについて詳しくは、[ドキュメント](/bolt-js/concepts#adding-editing-steps)を参照してください。
| `app.command(commandName, fn);` | Slash コマンドの呼び出しをリッスンします。`commandName` は文字列型で、アプリの設定で指定したスラッシュコマンドと一致する必要があります。スラッシュコマンドの名前では `/` を最初に配置します（例 : `/helpdesk`）。
| `app.options(actionId, fn);`    | 外部データソースを使用するセレクトメニューなどから送られる選択肢読み込みのリクエストをリッスンします。使う機会は多くありませんが、`app.action` と混同しないようにしましょう。`actionId` は文字列型で、アプリがビュー内に[外部データソースを使用するセレクトメニュー](https://api.slack.com/reference/block-kit/block-elements#external_select)を含めるときに指定した`action_id` と一致する必要があります。

#### 制約オブジェクト
一部のメソッドでは、さまざまな制約オブジェクトを指定することができます。制約オブジェクトを使用すると、リスナー関数で扱うイベントをさらに絞り込んだり、特定のケースに対応することができます。制約オブジェクトは、上で説明した識別子の代わりとしてメソッドに渡すことができます。さまざまな制約オブジェクトとそれを渡せるメソッドを以下の表にまとめます。 

| メソッド                                         | オプション | 詳細 |
|--------------------------------------------------------------------|
| `app.action(constraints, fn)` | `block_id`, `action_id`, `callback_id`, (,`type`) | `action_id` だけでなく、他の制約指定でもリッスンします。`block_id` は、エレメントの親ブロックの ID です。`callback_id` は、ビューの初期化時に指定したビューの ID です（モーダルに配置したアクションエレメントのみで使用できます）。`type` を指定することで、blocks内のアクションのみを処理するか、あるいは `attachments` 内のアクションのみなのかを選択できます。type に `block_actions` を指定すると、blocks内のアクションエレメントのみを処理します。`interactive_message` を指定すると、旧来の `attachments` 内のインタラクティブなアクションのみを処理します。 |
| `app.shortcut(constraints, fn)` | `type`, `callback_id` | 対象のショートカットの種類を指定できます。`type` に `shortcut`を指定すると**グローバルショートカット**、 `message_action`の場合は**メッセージショートカット**）となります。`callbackId` には文字列か正規表現を指定します。 |
| `app.view(constraints, fn)` | `type`, `callback_id` | `type` には `view_closed` または `view_submission` のいずれかを指定します。ここで指定した種別のイベントの場合のみリスナー関数にイベントが渡されます。`callback_id` は、アプリでモーダルを開く際に設定したビューの `callback_id` です。 |
| `app.options(constraints, fn)` | `block_id`, `action_id`, `callback_id` | 必須ではない設定として、`action_id` の他に `block_id` と `callback_id` もリッスンする条件に追加することができます。`callback_id` はモーダル内の options エレメントを処理する場合にのみ指定できます。 |

</div>

### リスナー関数の引数
リスナー関数がアクセスできる引数は、リスナー関数が渡されるメソッドによって決まります。以下の表は、これらの引数の説明です。この表は、それぞれの引数とそれにアクセスできるメソッドの詳細をカバーします。

| 引数  | 説明  |
| :---: | :--- |
| `payload` | すべてのリスナー | 受信したイベントペイロードから装飾部分などが取り除かれた本質的な内容部分。この内容や構造はイベントの種別によって異なります。このペイロード情報は下記の `body`のサブセットです。また、`payload` には、リスナーが渡されたメソッド名と同じ名前のエイリアスを使ってアクセスすることもできます（`message`、`event`、`action`、`shortcut`、`view`、`command`、`options`）。**payload の内容を簡単に確認する方法は、それを実際にログに出力してみることです**。または、[TypeScript](/bolt-js/tutorial/using-typescript) を使うのもよいでしょう。 |
| `say` | `message`, `event`, `action`, `command` | 受信したイベントが紐づいているチャンネルにメッセージを送信する関数。この引数が使用できるのは、リスナーをトリガーしたイベントにチャンネル ID が含まれる場合のみです（`message` イベントが最も一般的です）。`say` は、シンプルな文字列（プレーンテキストのメッセージ）またはオブジェクト（ブロックを含むメッセージ）を受け付けます。`say` は Promise を返します。この Promise は [`chat.postMessage` の応答でresolveされます](https://api.slack.com/methods/chat.postMessage)。もし`action` メソッドや、`message` 以外のイベントを使用する場合は、[イベントの payload にチャンネル ID が含まれているかを確認するようにしてください](https://api.slack.com/events)。
| `ack` | `action`, `shortcut`, `view`, `command`, `options` | アプリが受信イベントを受け取ったことを確認するために呼び出す**必要のある関数**。`ack` は応答の完了時にresolveする Promise を返します。詳しくは、[イベントの確認](#acknowledging-events)を参照してください。
| `client` | すべてのリスナー | イベントに関連づけられたトークンを使用する Web API クライアント。単一のワークスペースへのインストールでは、トークンは Appのコンストラクターに提供されます。複数のワークスペースへのインストールでは、トークンは `authorize` 関数から返されます。
| `respond` | `shortcut`, `action`, `command` | 受信イベントに `response_url` が**含まれる場合**に、受信イベントに応答を返す関数。`respond` は Promise を返します。この Promise は、`response_url` の応答結果に resolveされます。ショートカットに関しては、`respond` はメッセージショートカットで**のみ**動作します（グローバルショートカットでは動作しません）。
| `context` | すべてのリスナー | イベントのコンテキスト。このオブジェクトは、`botId` など、イベントやアプリに関するデータを保持します。イベントがリスナーに渡される前に、ミドルウェアで他のコンテキスト情報を追加することもできます。
| `body` | すべてのリスナー | リクエストの `body` 全体を保持するオブジェクト（`payload` のスーパーセット）。`trigger_id` や `authorizations` など、一部の付帯的なデータは payload の外側でのみ利用できます。

#### body と payload について

`payload` と `body` の構造は、API サイトで説明しています。

- `action` : [`body`](https://api.slack.com/reference/interaction-payloads/block-actions) と [`payload`](https://api.slack.com/reference/block-kit/block-elements) 
- `event` : [`body`](https://api.slack.com/types/event) と [`payload`](https://api.slack.com/events)
- `shortcut` : [`body` と `payload`](https://api.slack.com/reference/interaction-payloads/shortcuts)
- `command` : [`body`](https://api.slack.com/interactivity/slash-commands)
- `view` : [`view_submission` の `body` と `payload`](https://api.slack.com/reference/interaction-payloads/views#view_submission)、[`view_closed` の `body` と `payload`](https://api.slack.com/reference/interaction-payloads/views#view_closed)
- `options` : [`body` と `payload`](https://api.slack.com/reference/block-kit/block-elements#external_select)

### リスナーミドルウェアとの違い
リスナーミドルウェアは、多くのリスナー関数で利用するロジックを実装したい場合に使用します（全てのリスナーでは使わないようなケースで）。リスナーミドルウェアは、上で説明したリスナー関数と同じ引数を持ちますが、唯一異なるのは `next()` 関数を持っている点です。この関数は、実行のチェインを切らないために、**必ず呼び出される必要があります**。リスナーミドルウェアについて詳しくは、[ドキュメント](/bolt-js/concepts#listener-middleware)を参照してください。

## 初期化オプション
Bolt には、アプリをカスタマイズするためのさまざまな初期化オプションが用意されています。主なオプションには、Bolt アプリのオプションとレシーバーのオプションの 2 種類があります。レシーバーのオプションは、アプリで使用するレシーバーによって異なります。デフォルトの `HTTPReceiver` では以下のレシーバーオプションが利用できます（カスタムのレシーバーを使わない限りはこれらが利用できます）。

### レシーバーオプション
`HTTPReceiver` オプションは、Bolt App オプションと同様に、`App` のコンストラクターに渡すことができます。渡したオプションは、初期化の際に `HTTPReceiver` のインスタンスに渡されます。

| オプション  | 説明  |
| :---: | :--- |
| `signingSecret` | アプリの設定の「Basic Information」から取得した 文字列。受信イベントが Slack から送信されたものであることを検証するために使用されます。 |
| `endpoints` | レシーバーが Slack からの受信リクエストをリッスンするエンドポイントを指定する文字列または `オブジェクト`。現在、オブジェクトに指定できるキーはラベルとしての任意の文字列のみで、値にはカスタムのエンドポイントを指定します（例 : `/myapp/events`）。**デフォルトでは `/slack/events` というエンドポイントにすべてのイベントが送信されます。** |
| `processBeforeResponse` | イベントに対して即座に確認の応答を返すどうかを指定する真偽値。これは、主に FaaS プラットフォームでアプリを実行する場合に有用な設定です。 `true` に設定することでイベントのリスナーが予期せず終了することを防ぎます。デフォルトは `false` です。  |
| `clientId` | アプリの設定で指定した、クライアントの ID を示す 文字列。[OAuth の設定を行うために必要です](/bolt-js/concepts#authenticating-oauth)。 |
| `clientSecret` | アプリの設定で指定した、クライアントのシークレットキーを示す 文字列。[OAuth の設定を行うために必要です](/bolt-js/concepts#authenticating-oauth)。 |
| `stateSecret` | CSRF 攻撃を防ぐために [OAuth の設定時](/bolt-js/concepts#authenticating-oauth)に渡すことができる、推奨のパラメーター（文字列）。 |
| `installationStore` | [OAuth の設定時](/bolt-js/ja-jp/concepts#authenticating-oauth)に、インストールデータの保存・取得・削除の手段を定義します。`fetchInstallation` 、`storeInstallation`、`deleteInstallation` という 3 つのメソッドが含まれます。デフォルトの `installationStore` はインメモリストアです。 |
| `scopes` | アプリが [OAuth のプロセスの中で](/bolt-js/concepts#authenticating-oauth)アクセス許可を求めるスコープのリスト。 |
| `installerOptions` | [デフォルトの OAuth サポート](/bolt-js/concepts#authenticating-oauth)をカスタマイズする場合に指定するオブジェクト（必須ではない）。詳しくは、OAuth のドキュメントを参照してください。 |

### App オプション
App オプションは、`App` のコンストラクターに渡します。

| オプション  | 説明  |
| :---: | :--- |
| `receiver` | `Receiver` のインスタンス。受信イベントのパースとその処理を行います。[`Receiver` インターフェイス](/bolt-js/concepts#receiver)に準拠して、`init(app)`、`start()`、`stop()`を持つ必要があります。receiver について詳しくは、[ドキュメント](/bolt-js/concepts#receiver)を参照してください。 |
| `agent` | オプションの HTTP `エージェント`。プロキシのサポートを設定する場合に使用します。カスタムの agent について詳しくは、[Node Slack SDK のドキュメント](https://slack.dev/node-slack-sdk/web-api#proxy-requests-with-a-custom-agent)を参照してください。 |
| `clientTls` |  設定必須ではない文字列。HTTP クライアントリクエストにカスタムの TLS を設定する場合に指定します。`"pfx"`、`"key"`、`"passphrase"`、`"cert"`、`"ca"` のいずれかを指定します。 |
| `convoStore` | ステートに関連する会話のデータを設定・取得するためのデータストア実装。`set()` で会話のステートを設定し、`get()` で取得します。デフォルトでは、アプリはインメモリのストアを利用できます。詳細とサンプルについては、[ドキュメント](/bolt-js/concepts#conversation-store)を参照してください。 |
| `token` | アプリの設定（「Settings」>「Install App」）で指定した 文字列。Web API の呼び出しに必要です。`authorize`、`orgAuthorize`やOAuth 設定を使用する場合には指定しないでください。 |
| `botId` | `authorize` が定義されていない場合に限り指定できる、設定必須ではない`botId`（例 :`B12345`）。ボットトークンの ID で、アプリ自身によって送信されたメッセージを無視するために使用されます。`xoxb` トークンがアプリに渡されている場合、アプリは [`auth.test` メソッド](https://api.slack.com/methods/auth.test)を呼び出して、この値を自動的に取得します。 |
| `botUserId` | `authorize` が定義されていない場合に限り指定できる、設定必須ではない`botUserId`。`botId` とは異なり、ボットユーザーに関連づけられたユーザー ID を指します。ダイレクトメンションを識別するために使用します。`xoxb` トークンがアプリに渡されている場合、アプリは [`auth.test` メソッド](https://api.slack.com/methods/auth.test)を呼び出して、この値を自動的に取得します。 |
| `authorize` | 複数のチームでのインストールをサポートする場合に使用する関数。どのトークンが受信イベントに関連づけられているかを判断するのに使用します。`authorize` 関数に渡される元データには、場合によって `userId`、`conversationId`、`enterpriseId`、`teamId`、`isEnterpriseInstall` が含まれます（受信イベントによって異なります）。`authorize` 関数は、`botToken`、`botId`、`botUserId`、または `userToken`を返します。[ビルトインの OAuth サポート](/bolt-js/concepts#authenticating-oauth)を使用する場合、`authorize` 関数は自動的に作成されるため、自分で渡す必要はありません。`authorize` 関数について詳しくは、こちらを参照してください。   |
| `logger` | ビルトインのロガーの代わりにカスタムのロガーを渡すためのオプション。ロガーには特定のメソッドが実装されている必要があります。これには [`Logger` インターフェイス](https://github.com/slackapi/node-slack-sdk/blob/main/packages/logger/src/index.ts)で定義されている `setLevel(level:LogLevel)`、`getLevel()`、`setName(name: string)`、`debug(...msgs: any\[])`、`info(...msgs: any\[])`、`warn(...msgs: any\[])`、`error(...msgs: any\[])` があります。ログ出力の詳細については、[ドキュメント](/bolt-js/concepts#logging)を参照してください。  |
| `logLevel` | 出力するログのレベルを指定するオプション。`LogLevel` の出力に含まれる情報のレベルには、重要度の低い順から高い順に `DEBUG`、`INFO`、`WARN`、`ERROR` があります。デフォルトの `logLevel` は `INFO` に設定されています。ログ出力の詳細については、[ドキュメント](/bolt-js/concepts#logging)を参照してください。 |
| `ignoreSelf` | アプリ自身から発信されたメッセージをミドルウェアの関数で無視するかどうかを指定する真偽値。`botId` が必要です。デフォルトは `true` です。  |
| `clientOptions.slackApiUrl` | Slack Web API で使用するエンドポイントをカスタマイズできます。これが使用されるのはほとんどがテスト用途です。 | 

> Bolt のclientは [Node Slack SDK](/node-slack-sdk) の `WebClient` のインスタンスです。そのため、Node Slack SDK のドキュメントも合わせて参照すると、開発時の理解に役立つでしょう。

## フレームワークのエラー

Bolt では、さまざまなエラーが定義されています。これらにはより具体的なコンテキスト情報が含まるため、エラーのハンドリングが行いやすくなるでしょう。以下は、すべてのエラーコードを網羅しているわけではありませんが、開発中に目にすると思われるものを取り上げたエラーコードの一覧です。

| エラーコード                         | 詳細 |
|--------------------------------------------------------------------|
| `AppInitializationError` | 無効な初期化オプションが渡されたことを示します。原因として、署名シークレットが渡されていないことや、競合するオプションが指定されたことなどが考えられます（例 : `token` と `authorize` の両方を同時に指定することはできない）。`original` プロパティで詳細を確認できます。このエラーがスローされるのは、アプリのコンストラクターで行われる初期化時のみです。 |
| `AuthorizationError` | インストール情報が取得できなかった、またはパースできなかったときにのみスローされるエラーです。このエラーは、ビルトインの OAuth サポートを使用しているときに発生する可能性があります。また、独自の `authorize` 関数を作成するときに、このエラーをインポートして使用することができます。 |
| `ContextMissingPropertyError` | `context` オブジェクトに必要な情報が不足しているときにスローされるエラーです（例 : `ignoreSelf` を `true` に設定したのに `botUserId` または `botId` が含まれていない）。不足しているプロパティは、`missingProperty` プロパティで確認できます。 |
| `ReceiverMultipleAckError` | Receiver 内で、すでに確認が済んでいるリクエストに対してアプリがさらに `ack()` を呼んだ場合にスローされるエラーです。現在、デフォルトの `HTTPReceiver` でのみ使用されます。 |
| `ReceiverAuthenticityError` | アプリのリクエストの署名が検証できないときにスローされるエラーです。このエラーには、失敗した理由を示す情報が含まれます（例 : タイムスタンプが有効でない、ヘッダーに抜けがある、署名シークレットが有効でない）。
| `MultipleListenerError` | 単一のイベントに対して複数のリスナーでの処理中に複数のエラーが発生した場合にスローされるエラーです。個々のエラーを配列に収めた `originals` プロパティを持ちます。 |
| `WorkflowStepInitializationError` | 新しい `WorkflowStep` をインスタンス化する際に、設定オプションが無効な場合、または不足している場合にスローされるエラーです。原因として、`callback_id` が指定されていない、または設定オブジェクトが指定されていないことが考えられます。ワークフローステップについて詳しくは、[ドキュメント](/concepts#steps)を参照してください。  |
| `UnknownError` | フレームワーク内でスローされる、特定のエラーコードを持たないエラーです。`original` プロパティで詳細を確認できます。 |

> [errors.ts](https://github.com/slackapi/bolt-js/blob/main/src/errors.ts) のコードで、エラー定義の部分とコンストラクターの部分を読み、参考にしてみてください。

### クライアント側のエラー
Bolt では、Slack API の呼び出しのため `WebClient` をインポートしています。クライアントで API 呼び出しを行う際に目にすると思われるエラーを以下に示します。より詳しい内容は、[Web API のドキュメント](/node-slack-sdk/web-api#handle-errors)を参照してください。クライアントのエラーをハンドリングする際、`data` プロパティの `body` で詳しい情報を確認できます。

| エラーコード                         | 詳細 |
|--------------------------------------------------------------------|
| `PlatformError` | Slack API の呼び出し中に何らかの異常が発生したことを示すエラー。`data` プロパティを持ちます。 |
| `RequestError` | リクエストが送信できなかったことを示すエラー。ネットワーク接続が利用できないことなどが原因として考えられます。`original` プロパティで詳細を確認できます。 |
| `RateLimitedError` | 短時間で送信したリクエストが多すぎることを示すエラー。`retryAfter` プロパティで、再送信まで待機する必要のある秒数を確認できます。`WebClient` は、デフォルトでレート制限エラーのハンドリングを行います。[詳しくはドキュメントを参照してください](/node-slack-sdk/web-api#rate-limits)。 |
| `HTTPError` | HTTP レスポンスに通常は想定されないステータスコードが設定されていたことを示すエラー。Web API が返す HTTP ステータスコードは、通常 `200`（エラー時を含む）または `429`（レート制限時）のみです。 |
