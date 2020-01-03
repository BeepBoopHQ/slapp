---
title: レシーバーのカスタマイズ
lang: ja-jp
slug: receiver
order: 8
---

<div class="section-content">
レシーバーは、Slack から送信されたイベントを処理およびパースして発行するので、Bolt アプリがそのイベントにコンテキストを追加し、アプリのリスナーに渡すことができます。レシーバーは、レシーバーのインターフェイスに準拠している必要があります。

| メソッド      | パラメーター                       | 戻り値の型    |
|--------------|----------------------------------|-------------|
| `on()`       | `type: string`, `listener: fn()` | `unknown`   |
| `start()`    | None                             | `Promise`   |
| `stop()`     | None                             | `Promise`   |

Bolt アプリでは `on()` が 2 回呼び出されます。
* `Receiver.on('message', listener)` は、解析されたすべての着信リクエストを `onIncomingEvent()` にルーティングする必要があります。これは、Bolt アプリでは `this.receiver.on('message', message => this.onIncomingEvent(message))` として呼び出されます。
* `Receiver.on('error', listener)` は、エラーをグローバルエラーハンドラーにルーティングする必要があります。これは、Bolt アプリでは `this.receiver.on('error', error => this.onGlobalError(error))` として呼び出されます。

Bolt アプリを初期化するときにカスタムレシーバーをコンストラクタに渡すことで、そのカスタムレシーバーを使用できます。ここで紹介するのは、基本的なカスタムレシーバーです。

レシーバーについて詳しくは、[組み込み Express レシーバーのソースコード](https://github.com/slackapi/bolt/blob/master/src/ExpressReceiver.ts)をお読みください。
</div>

```javascript
import { EventEmitter } from 'events';
import { createServer } from 'http';
import express from 'express';

// EventEmitter は on() 関数を操作
// https://nodejs.org/api/events.html#events_emitter_on_eventname_listener
class simpleReceiver extends EventEmitter {
  constructor(signingSecret, endpoints) {
    super();
    this.app = express();
    this.server = createServer(this.app);

    for (const endpoint of endpoints) {
      this.app.post(endpoint, this.requestHandler.bind(this));
    }
  }

  start(port) {
    return new Promise((resolve, reject) => {
      try {
        this.server.listen(port, () => {
          resolve(this.server);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      })
    })
  }

  requestHandler(req, res) {
    // 着信リクエストをパースするparseBody 関数があると仮定
    const parsedReq = parseBody(req);
    const event = {
      body: parsedReq.body,
      // レシーバーが確認作業に重要
      ack: (response) => {
        if (!response) {
          res.send('')
        } else {
          res.send(response);
        }
      }
    };
    this.emit('message', event);
  }
}
```