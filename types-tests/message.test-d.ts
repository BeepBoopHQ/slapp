import { expectNotType, expectType, expectError } from 'tsd';
import { App, MessageEvent, GenericMessageEvent, BotMessageEvent, MessageRepliedEvent, MeMessageEvent, MessageDeletedEvent, ThreadBroadcastMessageEvent, MessageChangedEvent, EKMAccessDeniedMessageEvent } from '..';

const app = new App({ token: 'TOKEN', signingSecret: 'Signing Secret' });

expectType<void>(
  app.message(async ({ message }) => {
    expectType<MessageEvent>(message);

    message.channel; // the property access should compile

    // The type here is still a union type of all the possible subtyped events.
    // Thus, only the fields available for all the types can be resolved outside if/else statements.
    expectError(message.user);

    if (message.subtype === undefined) {
      expectType<GenericMessageEvent>(message);
      expectNotType<MessageEvent>(message);
      message.user; // the property access should compile
      message.channel; // the property access should compile
      message.team; // the property access should compile
    }
    if (message.subtype === 'bot_message') {
      expectType<BotMessageEvent>(message);
      expectNotType<MessageEvent>(message);
      message.user; // the property access should compile
      message.channel; // the property access should compile
    }
    if (message.subtype === 'ekm_access_denied') {
      expectType<EKMAccessDeniedMessageEvent>(message);
      expectNotType<MessageEvent>(message);
      message.user; // the property access should compile
      message.channel; // the property access should compile
    }
    if (message.subtype === 'me_message') {
      expectType<MeMessageEvent>(message);
      expectNotType<MessageEvent>(message);
      message.user; // the property access should compile
      message.channel; // the property access should compile
    }
    if (message.subtype === 'message_replied') {
      expectType<MessageRepliedEvent>(message);
      expectNotType<MessageEvent>(message);
      message.channel; // the property access should compile
      message.message; // the property access should compile
    }
    if (message.subtype === 'message_changed') {
      expectType<MessageChangedEvent>(message);
      expectNotType<MessageEvent>(message);
      message.channel; // the property access should compile
      message.message; // the property access should compile
    }
    if (message.subtype === 'message_deleted') {
      expectType<MessageDeletedEvent>(message);
      expectNotType<MessageEvent>(message);
      message.channel; // the property access should compile
      message.ts; // the property access should compile
    }
    if (message.subtype === 'thread_broadcast') {
      expectType<ThreadBroadcastMessageEvent>(message);
      expectNotType<MessageEvent>(message);
      message.channel; // the property access should compile
      message.thread_ts; // the property access should compile
      message.ts; // the property access should compile
      message.root; // the property access should compile
    }

    await Promise.resolve(message);
  }),
);

// Resolve the event type when having subtype in a listener constraint
// app.message<'message_replied'>('foo', async ({ message }) => {});

expectType<void>(
  app.message<'thread_broadcast'>('foo', async ({ message }) => {
    expectNotType<MessageEvent>(message);
    expectType<ThreadBroadcastMessageEvent>(message);
    message.channel; // the property access should compile
    message.thread_ts; // the property access should compile
    message.ts; // the property access should compile
    message.root; // the property access should compile
    await Promise.resolve(message);
  }),
);
expectType<void>(
  // no subtype in the event payload
  app.message<undefined>('foo', async ({ message }) => {
    expectNotType<MessageEvent>(message);
    expectType<GenericMessageEvent>(message);
    message.user; // the property access should compile
    message.channel; // the property access should compile
    message.team; // the property access should compile
    await Promise.resolve(message);
  }),
);
