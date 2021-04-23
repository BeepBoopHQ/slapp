import { expectType, expectNotType, expectError } from 'tsd';
import { App, OptionsRequest, OptionsSource } from '../dist';
import { Option } from '@slack/types';

const app = new App({ token: 'TOKEN', signingSecret: 'Signing Secret' });

const blockSuggestionOptions: Option[] = [
  {
    "text": {
      "type": "plain_text",
      "text": "foo"
    },
    "value": "bar"
  }
];

// set the default to block_suggestion
expectType<void>(app.options('action-id-or-callback-id', async ({ options, ack }) => {
  expectType<OptionsRequest<'block_suggestion'>>(options);
  expectType<never>(options.callback_id);
  options.block_id;
  options.action_id;
  // https://github.com/slackapi/bolt-js/issues/720
  await ack({ options: blockSuggestionOptions });
  await Promise.resolve(options);
}));

// block_suggestion
expectType<void>(app.options<'block_suggestion'>({ action_id: 'a' }, async ({ options, ack }) => {
  expectNotType<OptionsRequest<OptionsSource>>(options);
  expectType<OptionsRequest<'block_suggestion'>>(options);
  // https://github.com/slackapi/bolt-js/issues/720
  await ack({ options: blockSuggestionOptions });
  await Promise.resolve(options);
}));
// FIXME: app.options({ type: 'block_suggestion', action_id: 'a' } does not work

// interactive_message (attachments)
expectType<void>(app.options<'interactive_message'>({ callback_id: 'a' }, async ({ options, ack }) => {
  expectNotType<OptionsRequest<OptionsSource>>(options);
  expectType<OptionsRequest<'interactive_message'>>(options);
  // https://github.com/slackapi/bolt-js/issues/720
  expectError(ack({ options: blockSuggestionOptions }));
  await Promise.resolve(options);
}));

expectType<void>(app.options({ type: 'interactive_message', callback_id: 'a' }, async ({ options, ack }) => {
  // FIXME: the type should be OptionsRequest<'interactive_message'>
  expectType<OptionsRequest<OptionsSource>>(options);
  // https://github.com/slackapi/bolt-js/issues/720
  expectError(ack({ options: blockSuggestionOptions }));
  await Promise.resolve(options);
}));

// dialog_suggestion (dialog)
expectType<void>(app.options<'dialog_suggestion'>({ callback_id: 'a' }, async ({ options, ack }) => {
  expectNotType<OptionsRequest<OptionsSource>>(options);
  expectType<OptionsRequest<'dialog_suggestion'>>(options);
  // https://github.com/slackapi/bolt-js/issues/720
  expectError(ack({ options: blockSuggestionOptions }));
  await Promise.resolve(options);
}));
// FIXME: app.options({ type: 'dialog_suggestion', callback_id: 'a' } does not work
