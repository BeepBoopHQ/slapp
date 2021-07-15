import 'mocha';
import sinon, { SinonSpy } from 'sinon';
import { assert } from 'chai';
import { Override, mergeOverrides, createFakeLogger, delay } from './test-helpers';
import rewiremock from 'rewiremock';
import { ErrorCode, UnknownError, AuthorizationError, CodedError } from './errors';
import { Receiver, ReceiverEvent, SayFn, NextFn } from './types';
import { ConversationStore } from './conversation-store';
import { LogLevel } from '@slack/logger';
import App, { ExtendedErrorHandlerArgs, ViewConstraints } from './App';
import { WebClientOptions, WebClient } from '@slack/web-api';
import { WorkflowStep } from './WorkflowStep';

// Utility functions
const noop = () => Promise.resolve(undefined);
const noopMiddleware = async ({ next }: { next: NextFn }) => {
  await next();
};
const noopAuthorize = () => Promise.resolve({});

// Dummies (values that have no real behavior but pass through the system opaquely)
function createDummyReceiverEvent(type: string = 'dummy_event_type'): ReceiverEvent {
  // NOTE: this is a degenerate ReceiverEvent that would successfully pass through the App. it happens to look like a
  // IncomingEventType.Event
  return {
    body: {
      event: {
        type,
      },
    },
    ack: noop,
  };
}

describe('App', () => {
  describe('constructor', () => {
    // TODO: test when the single team authorization results fail. that should still succeed but warn. it also means
    // that the `ignoreSelf` middleware will fail (or maybe just warn) a bunch.
    describe('with successful single team authorization results', () => {
      it('should succeed with a token for single team authorization', async () => {
        // Arrange
        const fakeBotId = 'B_FAKE_BOT_ID';
        const fakeBotUserId = 'U_FAKE_BOT_USER_ID';
        const overrides = mergeOverrides(
          withNoopAppMetadata(),
          withSuccessfulBotUserFetchingWebClient(fakeBotId, fakeBotUserId),
        );
        const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

        // Act
        const app = new App({ token: '', signingSecret: '' });

        // Assert
        // TODO: verify that the fake bot ID and fake bot user ID are retrieved
        assert.instanceOf(app, App);
      });
      it('should pass the given token to app.client', async () => {
        // Arrange
        const fakeBotId = 'B_FAKE_BOT_ID';
        const fakeBotUserId = 'U_FAKE_BOT_USER_ID';
        const overrides = mergeOverrides(
          withNoopAppMetadata(),
          withSuccessfulBotUserFetchingWebClient(fakeBotId, fakeBotUserId),
        );
        const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

        // Act
        const app = new App({ token: 'xoxb-foo-bar', signingSecret: '' });

        // Assert
        assert.isDefined(app.client);
        assert.equal(app.client.token, 'xoxb-foo-bar');
      });
    });
    it('should succeed with an authorize callback', async () => {
      // Arrange
      const authorizeCallback = sinon.fake();
      const App = await importApp(); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

      // Act
      const app = new App({ authorize: authorizeCallback, signingSecret: '' });

      // Assert
      assert(authorizeCallback.notCalled, 'Should not call the authorize callback on instantiation');
      assert.instanceOf(app, App);
    });
    it('should fail without a token for single team authorization, authorize callback, nor oauth installer', async () => {
      // Arrange
      const App = await importApp(); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

      // Act
      try {
        new App({ signingSecret: '' }); // eslint-disable-line @typescript-eslint/no-unused-expressions
        assert.fail();
      } catch (error) {
        // Assert
        assert.propertyVal(error, 'code', ErrorCode.AppInitializationError);
      }
    });
    it('should fail when both a token and authorize callback are specified', async () => {
      // Arrange
      const authorizeCallback = sinon.fake();
      const App = await importApp(); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

      // Act
      try {
        // eslint-disable-line @typescript-eslint/no-unused-expressions
        new App({ token: '', authorize: authorizeCallback, signingSecret: '' });
        assert.fail();
      } catch (error) {
        // Assert
        assert.propertyVal(error, 'code', ErrorCode.AppInitializationError);
        assert(authorizeCallback.notCalled);
      }
    });
    it('should fail when both a token is specified and OAuthInstaller is initialized', async () => {
      // Arrange
      const authorizeCallback = sinon.fake();
      const App = await importApp(); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

      // Act
      try {
        // eslint-disable-line @typescript-eslint/no-unused-expressions
        new App({ token: '', clientId: '', clientSecret: '', stateSecret: '', signingSecret: '' });
        assert.fail();
      } catch (error) {
        // Assert
        assert.propertyVal(error, 'code', ErrorCode.AppInitializationError);
        assert(authorizeCallback.notCalled);
      }
    });
    it('should fail when both a authorize callback is specified and OAuthInstaller is initialized', async () => {
      // Arrange
      const authorizeCallback = sinon.fake();
      const App = await importApp(); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

      // Act
      try {
        // eslint-disable-line @typescript-eslint/no-unused-expressions
        new App({ authorize: authorizeCallback, clientId: '', clientSecret: '', stateSecret: '', signingSecret: '' });
        assert.fail();
      } catch (error) {
        // Assert
        assert.propertyVal(error, 'code', ErrorCode.AppInitializationError);
        assert(authorizeCallback.notCalled);
      }
    });
    describe('with a custom receiver', () => {
      it('should succeed with no signing secret', async () => {
        // Arrange
        const App = await importApp(); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

        // Act
        const app = new App({ receiver: new FakeReceiver(), authorize: noopAuthorize });

        // Assert
        assert.instanceOf(app, App);
      });
    });
    it('should fail when no signing secret for the default receiver is specified', async () => {
      // Arrange
      const App = await importApp(); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

      // Act
      try {
        new App({ authorize: noopAuthorize }); // eslint-disable-line @typescript-eslint/no-unused-expressions
        assert.fail();
      } catch (error) {
        // Assert
        assert.propertyVal(error, 'code', ErrorCode.AppInitializationError);
      }
    });
    it('should initialize MemoryStore conversation store by default', async () => {
      // Arrange
      const fakeMemoryStore = sinon.fake();
      const fakeConversationContext = sinon.fake.returns(noopMiddleware);
      const overrides = mergeOverrides(
        withNoopAppMetadata(),
        withNoopWebClient(),
        withMemoryStore(fakeMemoryStore),
        withConversationContext(fakeConversationContext),
      );
      const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

      // Act
      const app = new App({ authorize: noopAuthorize, signingSecret: '' });

      // Assert
      assert.instanceOf(app, App);
      assert(fakeMemoryStore.calledWithNew);
      assert(fakeConversationContext.called);
    });
    it('should initialize without a conversation store when option is false', async () => {
      // Arrange
      const fakeConversationContext = sinon.fake.returns(noopMiddleware);
      const overrides = mergeOverrides(
        withNoopAppMetadata(),
        withNoopWebClient(),
        withConversationContext(fakeConversationContext),
      );
      const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

      // Act
      const app = new App({ convoStore: false, authorize: noopAuthorize, signingSecret: '' });

      // Assert
      assert.instanceOf(app, App);
      assert(fakeConversationContext.notCalled);
    });
    describe('with a custom conversation store', () => {
      it('should initialize the conversation store', async () => {
        // Arrange
        const fakeConversationContext = sinon.fake.returns(noopMiddleware);
        const overrides = mergeOverrides(
          withNoopAppMetadata(),
          withNoopWebClient(),
          withConversationContext(fakeConversationContext),
        );
        const dummyConvoStore = Symbol() as unknown as ConversationStore;
        const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

        // Act
        const app = new App({ convoStore: dummyConvoStore, authorize: noopAuthorize, signingSecret: '' });

        // Assert
        assert.instanceOf(app, App);
        assert(fakeConversationContext.firstCall.calledWith(dummyConvoStore));
      });
    });
    it('with clientOptions', async () => {
      const fakeConstructor = sinon.fake();
      const overrides = mergeOverrides(withNoopAppMetadata(), {
        '@slack/web-api': {
          WebClient: class {
            constructor() {
              fakeConstructor(...arguments);
            }
          },
        },
      });

      const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

      const clientOptions = { slackApiUrl: 'proxy.slack.com' };

      new App({ clientOptions, authorize: noopAuthorize, signingSecret: '', logLevel: LogLevel.ERROR }); // eslint-disable-line @typescript-eslint/no-unused-expressions

      assert.ok(fakeConstructor.called);

      const [token, options] = fakeConstructor.lastCall.args;
      assert.strictEqual(undefined, token, 'token should be undefined');
      assert.strictEqual(clientOptions.slackApiUrl, options.slackApiUrl);
      assert.strictEqual(LogLevel.ERROR, options.logLevel, 'override logLevel');
    });
    it('should not perform auth.test API call if tokenVerificationEnabled is false', async () => {
      // Arrange
      const fakeConstructor = sinon.fake();
      const overrides = mergeOverrides(withNoopAppMetadata(), {
        '@slack/web-api': {
          WebClient: class {
            constructor() {
              fakeConstructor(...arguments);
            }
            public auth = {
              test: () => {
                throw new Error('This API method call should not be performed');
              },
            };
          },
        },
      });

      const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention,
      const app = new App({
        token: 'xoxb-completely-invalid-token',
        signingSecret: 'invalid-one',
        tokenVerificationEnabled: false,
      });
      // Assert
      assert.instanceOf(app, App);
    });
    // TODO: tests for ignoreSelf option
    // TODO: tests for logger and logLevel option
    // TODO: tests for providing botId and botUserId options
    // TODO: tests for providing endpoints option
  });

  describe('#start', () => {
    // The following test case depends on a definition of App that is generic on its Receiver type. This will be
    // addressed in the future. It cannot even be left uncommented with the `it.skip()` global because it will fail
    // TypeScript compilation as written.
    // it('should pass calls through to receiver', async () => {
    //   // Arrange
    //   const dummyReturn = Symbol();
    //   const dummyParams = [Symbol(), Symbol()];
    //   const fakeReceiver = new FakeReceiver();
    //   const App = await importApp(); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match
    //   const app = new App({ receiver: fakeReceiver, authorize: noopAuthorize });
    //   fakeReceiver.start = sinon.fake.returns(dummyReturn);
    //   // Act
    //   const actualReturn = await app.start(...dummyParams);
    //   // Assert
    //   assert.deepEqual(actualReturn, dummyReturn);
    //   assert.deepEqual(dummyParams, fakeReceiver.start.firstCall.args);
    // });
    // TODO: another test case to take the place of the one above (for coverage until the definition of App is made
    // generic).
  });

  describe('#stop', () => {
    it('should pass calls through to receiver', async () => {
      // Arrange
      const dummyReturn = Symbol();
      const dummyParams = [Symbol(), Symbol()];
      const fakeReceiver = new FakeReceiver();
      const App = await importApp(); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match
      fakeReceiver.stop = sinon.fake.returns(dummyReturn);

      // Act
      const app = new App({ receiver: fakeReceiver, authorize: noopAuthorize }); // eslint-disable-line @typescript-eslint/no-unused-expressions
      const actualReturn = await app.stop(...dummyParams);

      // Assert
      assert.deepEqual(actualReturn, dummyReturn);
      assert.deepEqual(dummyParams, fakeReceiver.stop.firstCall.args);
    });
  });

  describe('event processing', () => {
    let fakeReceiver: FakeReceiver;
    let fakeErrorHandler: SinonSpy;
    let dummyAuthorizationResult: { botToken: string; botId: string };

    beforeEach(() => {
      fakeReceiver = new FakeReceiver();
      fakeErrorHandler = sinon.fake();
      dummyAuthorizationResult = { botToken: '', botId: '' };
    });

    // TODO: verify that authorize callback is called with the correct properties and responds correctly to
    // various return values

    function createInvalidReceiverEvents(): ReceiverEvent[] {
      // TODO: create many more invalid receiver events (fuzzing)
      return [
        {
          body: {},
          ack: sinon.fake.resolves(undefined),
        },
      ];
    }

    it('should warn and skip when processing a receiver event with unknown type (never crash)', async () => {
      // Arrange
      const fakeLogger = createFakeLogger();
      const fakeMiddleware = sinon.fake(noopMiddleware);
      const invalidReceiverEvents = createInvalidReceiverEvents();
      const App = await importApp(); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

      // Act
      const app = new App({ receiver: fakeReceiver, logger: fakeLogger, authorize: noopAuthorize });
      app.use(fakeMiddleware);
      await Promise.all(invalidReceiverEvents.map((event) => fakeReceiver.sendEvent(event)));

      // Assert
      assert(fakeErrorHandler.notCalled);
      assert(fakeMiddleware.notCalled);
      assert.isAtLeast(fakeLogger.warn.callCount, invalidReceiverEvents.length);
    });

    it('should warn, send to global error handler, and skip when a receiver event fails authorization', async () => {
      // Arrange
      const fakeLogger = createFakeLogger();
      const fakeMiddleware = sinon.fake(noopMiddleware);
      const dummyOrigError = new Error('auth failed');
      const dummyAuthorizationError = new AuthorizationError('auth failed', dummyOrigError);
      const dummyReceiverEvent = createDummyReceiverEvent();
      const App = await importApp(); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

      // Act
      const app = new App({
        receiver: fakeReceiver,
        logger: fakeLogger,
        authorize: sinon.fake.rejects(dummyAuthorizationError),
      });
      app.use(fakeMiddleware);
      app.error(fakeErrorHandler);
      await fakeReceiver.sendEvent(dummyReceiverEvent);

      // Assert
      assert(fakeMiddleware.notCalled);
      assert(fakeLogger.warn.called);
      assert.instanceOf(fakeErrorHandler.firstCall.args[0], Error);
      assert.propertyVal(fakeErrorHandler.firstCall.args[0], 'code', ErrorCode.AuthorizationError);
      assert.propertyVal(fakeErrorHandler.firstCall.args[0], 'original', dummyAuthorizationError.original);
    });

    describe('global middleware', () => {
      let fakeFirstMiddleware: SinonSpy;
      let fakeSecondMiddleware: SinonSpy;
      let app: App;
      let dummyReceiverEvent: ReceiverEvent;

      beforeEach(async () => {
        const fakeConversationContext = sinon.fake.returns(noopMiddleware);
        const overrides = mergeOverrides(
          withNoopAppMetadata(),
          withNoopWebClient(),
          withMemoryStore(sinon.fake()),
          withConversationContext(fakeConversationContext),
        );
        const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

        dummyReceiverEvent = createDummyReceiverEvent();
        fakeFirstMiddleware = sinon.fake(noopMiddleware);
        fakeSecondMiddleware = sinon.fake(noopMiddleware);

        app = new App({
          logger: createFakeLogger(),
          receiver: fakeReceiver,
          authorize: sinon.fake.resolves(dummyAuthorizationResult),
        });
      });

      it('should error if next called multiple times', async () => {
        // Arrange
        app.use(fakeFirstMiddleware);
        app.use(async ({ next }) => {
          await next!();
          await next!();
        });
        app.use(fakeSecondMiddleware);
        app.error(fakeErrorHandler);

        // Act
        await fakeReceiver.sendEvent(dummyReceiverEvent);

        // Assert
        assert.instanceOf(fakeErrorHandler.firstCall.args[0], Error);
      });

      it('correctly waits for async listeners', async () => {
        let changed = false;

        app.use(async ({ next }) => {
          await delay(100);
          changed = true;

          await next!();
        });

        await fakeReceiver.sendEvent(dummyReceiverEvent);
        assert.isTrue(changed);
        assert(fakeErrorHandler.notCalled);
      });

      it('throws errors which can be caught by upstream async listeners', async () => {
        const thrownError = new Error('Error handling the message :(');
        let caughtError;

        app.use(async ({ next }) => {
          try {
            await next!();
          } catch (err) {
            caughtError = err;
          }
        });

        app.use(async () => {
          throw thrownError;
        });

        app.error(fakeErrorHandler);

        await fakeReceiver.sendEvent(dummyReceiverEvent);

        assert.equal(caughtError, thrownError);
        assert(fakeErrorHandler.notCalled);
      });

      it('calls async middleware in declared order', async () => {
        const message = ':wave:';
        let middlewareCount = 0;

        /**
         * Middleware that, when called, asserts that it was called in the correct order
         * @param orderDown The order it should be called when processing middleware down the chain
         * @param orderUp The order it should be called when processing middleware up the chain
         */
        const assertOrderMiddleware =
          (orderDown: number, orderUp: number) =>
          async ({ next }: { next?: NextFn }) => {
            await delay(100);
            middlewareCount += 1;
            assert.equal(middlewareCount, orderDown);
            if (next !== undefined) {
              await next();
            }
            middlewareCount += 1;
            assert.equal(middlewareCount, orderUp);
          };

        app.use(assertOrderMiddleware(1, 8));
        app.message(message, assertOrderMiddleware(3, 6), assertOrderMiddleware(4, 5));
        app.use(assertOrderMiddleware(2, 7));
        app.error(fakeErrorHandler);

        await fakeReceiver.sendEvent({
          ...dummyReceiverEvent,
          body: {
            type: 'event_callback',
            event: {
              type: 'message',
              text: message,
            },
          },
        });

        assert.equal(middlewareCount, 8);
        assert(fakeErrorHandler.notCalled);
      });

      it('should, on error, call the global error handler, not extended', async () => {
        const error = new Error('Everything is broke, you probably should restart, if not then good luck');

        app.use(() => {
          throw error;
        });

        app.error(async (codedError: CodedError) => {
          assert.instanceOf(codedError, UnknownError);
          assert.equal(codedError.message, error.message);
        });

        await fakeReceiver.sendEvent(dummyReceiverEvent);
      });

      it('should, on error, call the global error handler, extended', async () => {
        const error = new Error('Everything is broke, you probably should restart, if not then good luck');
        // Need to change value of private property for testing purposes
        // @ts-ignore
        app.extendedErrorHandler = true;

        app.use(() => {
          throw error;
        });

        app.error(async (args: ExtendedErrorHandlerArgs) => {
          assert.property(args, 'error');
          assert.property(args, 'body');
          assert.property(args, 'context');
          assert.property(args, 'logger');
          assert.isDefined(args.error);
          assert.isDefined(args.body);
          assert.isDefined(args.context);
          assert.isDefined(args.logger);
          assert.equal(args.error.message, error.message);
        });

        await fakeReceiver.sendEvent(dummyReceiverEvent);

        // Switch back to false to make sure nothing breaks
        // @ts-ignore
        app.extendedErrorHandler = false;
      });

      it('with a default global error handler, rejects App#ProcessEvent', async () => {
        const error = new Error('The worst has happened, bot is beyond saving, always hug servers');
        let actualError;

        app.use(() => {
          throw error;
        });

        try {
          await fakeReceiver.sendEvent(dummyReceiverEvent);
        } catch (err) {
          actualError = err;
        }

        assert.instanceOf(actualError, UnknownError);
        assert.equal(actualError.message, error.message);
      });
    });

    describe('listener middleware', () => {
      let app: App;
      const eventType = 'some_event_type';
      const dummyReceiverEvent = createDummyReceiverEvent(eventType);

      beforeEach(async () => {
        const App = await importApp(); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match
        app = new App({
          receiver: fakeReceiver,
          authorize: sinon.fake.resolves(dummyAuthorizationResult),
        });
        app.error(fakeErrorHandler);
      });

      it('should bubble up errors in listeners to the global error handler', async () => {
        // Arrange
        const errorToThrow = new Error('listener error');

        // Act
        app.event(eventType, async () => {
          throw errorToThrow;
        });
        await fakeReceiver.sendEvent(dummyReceiverEvent);

        // Assert
        assert(fakeErrorHandler.calledOnce);
        const error = fakeErrorHandler.firstCall.args[0];
        assert.equal(error.code, ErrorCode.UnknownError);
        assert.equal(error.original, errorToThrow);
      });

      it('should aggregate multiple errors in listeners for the same incoming event', async () => {
        // Arrange
        const errorsToThrow = [new Error('first listener error'), new Error('second listener error')];
        function createThrowingListener(toBeThrown: Error): () => Promise<void> {
          return async () => {
            throw toBeThrown;
          };
        }

        // Act
        app.event(eventType, createThrowingListener(errorsToThrow[0]));
        app.event(eventType, createThrowingListener(errorsToThrow[1]));
        await fakeReceiver.sendEvent(dummyReceiverEvent);

        // Assert
        assert(fakeErrorHandler.calledOnce);
        const error = fakeErrorHandler.firstCall.args[0];
        assert.instanceOf(error, Error);
        assert(error.code === ErrorCode.MultipleListenerError);
        assert.sameMembers(error.originals, errorsToThrow);
      });

      it('should detect invalid event names', async () => {
        app.event('app_mention', async () => {});
        app.event('message', async () => {});
        assert.throws(() => app.event('message.channels', async () => {}), 'Although the document mentions');
        assert.throws(() => app.event(/message\..+/, async () => {}), 'Although the document mentions');
      });
    });

    describe('WorkflowStep middleware', () => {
      let app: App;

      beforeEach(async () => {
        const App = await importApp(); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match
        app = new App({
          receiver: fakeReceiver,
          authorize: sinon.fake.resolves(dummyAuthorizationResult),
        });
      });

      it('should add a listener to middleware for each WorkflowStep passed to app.step', async () => {
        const ws = new WorkflowStep('test_id', { edit: [], save: [], execute: [] });

        /* middleware is a private property on App. Since app.step relies on app.use,
        and app.use is fully tested above, we're opting just to ensure that the step listener
        is added to the global middleware array, rather than repeating the same tests. */
        const middleware = (app as any).middleware;

        assert.equal(middleware.length, 2);

        app.step(ws);

        assert.equal(middleware.length, 3);
      });
    });

    describe('middleware and listener arguments', () => {
      let fakeErrorHandler: SinonSpy;
      const dummyChannelId = 'CHANNEL_ID';
      let overrides: Override;
      const baseEvent = createDummyReceiverEvent();

      function buildOverrides(secondOverrides: Override[]): Override {
        fakeErrorHandler = sinon.fake();
        overrides = mergeOverrides(
          withNoopAppMetadata(),
          ...secondOverrides,
          withMemoryStore(sinon.fake()),
          withConversationContext(sinon.fake.returns(noopMiddleware)),
        );
        return overrides;
      }

      describe('authorize', () => {
        it('should extract valid enterprise_id in a shared channel #935', async () => {
          // Arrange
          const fakeAxiosPost = sinon.fake.resolves({});
          const overrides = buildOverrides([withNoopWebClient(), withAxiosPost(fakeAxiosPost)]);
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

          // Act
          let workedAsExpected = false;
          const app = new App({
            receiver: fakeReceiver,
            authorize: async ({ enterpriseId }) => {
              if (enterpriseId !== undefined) {
                throw new Error('the enterprise_id must be undefined in this scenario');
              }
              return dummyAuthorizationResult;
            },
          });
          app.event('message', async () => {
            workedAsExpected = true;
          });
          await fakeReceiver.sendEvent({
            ack: noop,
            body: {
              team_id: 'T_connected_grid_workspace',
              enterprise_id: 'E_org_id',
              api_app_id: 'A111',
              event: {
                type: 'message',
                text: ':wave: Hi, this is my first message in a Slack Connect channel!',
                user: 'U111',
                ts: '1622099033.001500',
                team: 'T_this_non_grid_workspace',
                channel: 'C111',
                channel_type: 'channel',
              },
              type: 'event_callback',
              authorizations: [
                {
                  enterprise_id: null,
                  team_id: 'T_this_non_grid_workspace',
                  user_id: 'U_authed_user',
                  is_bot: true,
                  is_enterprise_install: false,
                },
              ],
              is_ext_shared_channel: true,
              event_context: '2-message-T_connected_grid_workspace-A111-C111',
            },
          });

          // Assert
          assert.isTrue(workedAsExpected);
        });
      });

      describe('routing', () => {
        function createReceiverEvents(): ReceiverEvent[] {
          return [
            {
              // IncomingEventType.Event (app.event)
              ...baseEvent,
              body: {
                event: {},
              },
            },
            {
              // IncomingEventType.Command (app.command)
              ...baseEvent,
              body: {
                command: '/COMMAND_NAME',
                is_enterprise_install: 'false',
              },
            },
            {
              // IncomingEventType.Action (app.action)
              ...baseEvent,
              body: {
                type: 'block_actions',
                actions: [
                  {
                    action_id: 'block_action_id',
                  },
                ],
                channel: {},
                user: {},
                team: {},
              },
            },
            {
              // IncomingEventType.Shortcut (app.shortcut)
              ...baseEvent,
              body: {
                type: 'message_action',
                callback_id: 'message_action_callback_id',
                channel: {},
                user: {},
                team: {},
              },
            },
            {
              // IncomingEventType.Shortcut (app.shortcut)
              ...baseEvent,
              body: {
                type: 'message_action',
                callback_id: 'another_message_action_callback_id',
                channel: {},
                user: {},
                team: {},
              },
            },
            {
              // IncomingEventType.Shortcut (app.shortcut)
              ...baseEvent,
              body: {
                type: 'shortcut',
                callback_id: 'shortcut_callback_id',
                channel: {},
                user: {},
                team: {},
              },
            },
            {
              // IncomingEventType.Shortcut (app.shortcut)
              ...baseEvent,
              body: {
                type: 'shortcut',
                callback_id: 'another_shortcut_callback_id',
                channel: {},
                user: {},
                team: {},
              },
            },
            {
              // IncomingEventType.Action (app.action)
              ...baseEvent,
              body: {
                type: 'interactive_message',
                callback_id: 'interactive_message_callback_id',
                actions: [{}],
                channel: {},
                user: {},
                team: {},
              },
            },
            {
              // IncomingEventType.Action with dialog submission (app.action)
              ...baseEvent,
              body: {
                type: 'dialog_submission',
                callback_id: 'dialog_submission_callback_id',
                channel: {},
                user: {},
                team: {},
              },
            },
            {
              // IncomingEventType.Action for an external_select block (app.options)
              ...baseEvent,
              body: {
                type: 'block_suggestion',
                action_id: 'external_select_action_id',
                channel: {},
                user: {},
                team: {},
                actions: [],
              },
            },
            {
              // IncomingEventType.Action for "data_source": "external" in dialogs (app.options)
              ...baseEvent,
              body: {
                type: 'dialog_suggestion',
                callback_id: 'dialog_suggestion_callback_id',
                name: 'the name',
                channel: {},
                user: {},
                team: {},
              },
            },
            {
              // IncomingEventType.ViewSubmitAction (app.view)
              ...baseEvent,
              body: {
                type: 'view_submission',
                channel: {},
                user: {},
                team: {},
                view: {
                  callback_id: 'view_callback_id',
                },
              },
            },
            {
              ...baseEvent,
              body: {
                type: 'view_submission',
                channel: {},
                user: {},
                team: null,
                enterprise: {},
                view: {
                  callback_id: 'view_callback_id',
                },
              },
            },
            {
              ...baseEvent,
              body: {
                type: 'view_submission',
                channel: {},
                user: {},
                enterprise: {},
                // Although {team: undefined} pattern does not exist as of Jan 2021,
                // this test verifies if App works even if the field is missing.
                view: {
                  callback_id: 'view_callback_id',
                },
              },
            },
            {
              ...baseEvent,
              body: {
                type: 'view_submission',
                channel: {},
                user: {},
                team: {},
                // Although {enterprise: undefined} pattern does not exist as of Jan 2021,
                // this test verifies if App works even if the field is missing.
                view: {
                  callback_id: 'view_callback_id',
                },
              },
            },
            {
              ...baseEvent,
              body: {
                type: 'view_closed',
                channel: {},
                user: {},
                team: {},
                view: {
                  callback_id: 'view_callback_id',
                },
              },
            },
            {
              ...baseEvent,
              body: {
                type: 'event_callback',
                token: 'XXYYZZ',
                team_id: 'TXXXXXXXX',
                api_app_id: 'AXXXXXXXXX',
                event: {
                  type: 'message',
                  event_ts: '1234567890.123456',
                  user: 'UXXXXXXX1',
                  text: 'hello friends!',
                },
              },
            },
          ];
        }

        function createOrgAppReceiverEvents(): ReceiverEvent[] {
          return [
            {
              // IncomingEventType.Event (app.event)
              ...baseEvent,
              body: {
                event: {},
                is_enterprise_install: true,
                enterprise: {
                  id: 'E12345678',
                },
              },
            },
            {
              // IncomingEventType.Command (app.command)
              ...baseEvent,
              body: {
                command: '/COMMAND_NAME',
                is_enterprise_install: 'true',
                enterprise_id: 'E12345678',
              },
            },
            {
              // IncomingEventType.Action (app.action)
              ...baseEvent,
              body: {
                type: 'block_actions',
                actions: [
                  {
                    action_id: 'block_action_id',
                  },
                ],
                channel: {},
                user: {},
                team: {},
                is_enterprise_install: true,
                enterprise: {
                  id: 'E12345678',
                },
              },
            },
            {
              // IncomingEventType.Shortcut (app.shortcut)
              ...baseEvent,
              body: {
                type: 'message_action',
                callback_id: 'message_action_callback_id',
                channel: {},
                user: {},
                team: {},
                is_enterprise_install: true,
                enterprise: {
                  id: 'E12345678',
                },
              },
            },
            {
              // IncomingEventType.Shortcut (app.shortcut)
              ...baseEvent,
              body: {
                type: 'message_action',
                callback_id: 'another_message_action_callback_id',
                channel: {},
                user: {},
                team: {},
                is_enterprise_install: true,
                enterprise: {
                  id: 'E12345678',
                },
              },
            },
            {
              // IncomingEventType.Shortcut (app.shortcut)
              ...baseEvent,
              body: {
                type: 'shortcut',
                callback_id: 'shortcut_callback_id',
                channel: {},
                user: {},
                team: {},
                is_enterprise_install: true,
                enterprise: {
                  id: 'E12345678',
                },
              },
            },
            {
              // IncomingEventType.Shortcut (app.shortcut)
              ...baseEvent,
              body: {
                type: 'shortcut',
                callback_id: 'another_shortcut_callback_id',
                channel: {},
                user: {},
                team: {},
                is_enterprise_install: true,
                enterprise: {
                  id: 'E12345678',
                },
              },
            },
            {
              // IncomingEventType.Action (app.action)
              ...baseEvent,
              body: {
                type: 'interactive_message',
                callback_id: 'interactive_message_callback_id',
                actions: [{}],
                channel: {},
                user: {},
                team: {},
                is_enterprise_install: true,
                enterprise: {
                  id: 'E12345678',
                },
              },
            },
            {
              // IncomingEventType.Action with dialog submission (app.action)
              ...baseEvent,
              body: {
                type: 'dialog_submission',
                callback_id: 'dialog_submission_callback_id',
                channel: {},
                user: {},
                team: {},
                is_enterprise_install: true,
                enterprise: {
                  id: 'E12345678',
                },
              },
            },
            {
              // IncomingEventType.Action for an external_select block (app.options)
              ...baseEvent,
              body: {
                type: 'block_suggestion',
                action_id: 'external_select_action_id',
                channel: {},
                user: {},
                team: {},
                actions: [],
                is_enterprise_install: true,
                enterprise: {
                  id: 'E12345678',
                },
              },
            },
            {
              // IncomingEventType.Action for "data_source": "external" in dialogs (app.options)
              ...baseEvent,
              body: {
                type: 'dialog_suggestion',
                callback_id: 'dialog_suggestion_callback_id',
                name: 'the name',
                channel: {},
                user: {},
                team: {},
                is_enterprise_install: true,
                enterprise: {
                  id: 'E12345678',
                },
              },
            },
            {
              // IncomingEventType.ViewSubmitAction (app.view)
              ...baseEvent,
              body: {
                type: 'view_submission',
                channel: {},
                user: {},
                team: {},
                view: {
                  callback_id: 'view_callback_id',
                },
                is_enterprise_install: true,
                enterprise: {
                  id: 'E12345678',
                },
              },
            },
            {
              ...baseEvent,
              body: {
                type: 'view_closed',
                channel: {},
                user: {},
                team: {},
                view: {
                  callback_id: 'view_callback_id',
                },
                is_enterprise_install: true,
                enterprise: {
                  id: 'E12345678',
                },
              },
            },
            {
              ...baseEvent,
              body: {
                type: 'event_callback',
                token: 'XXYYZZ',
                team_id: 'TXXXXXXXX',
                api_app_id: 'AXXXXXXXXX',
                event: {
                  type: 'message',
                  event_ts: '1234567890.123456',
                  user: 'UXXXXXXX1',
                  text: 'hello friends!',
                },
                is_enterprise_install: true,
                enterprise: {
                  id: 'E12345678',
                },
              },
            },
          ];
        }

        it('should acknowledge any of possible events', async () => {
          // Arrange
          const ackFn = sinon.fake.resolves({});
          const actionFn = sinon.fake.resolves({});
          const shortcutFn = sinon.fake.resolves({});
          const viewFn = sinon.fake.resolves({});
          const optionsFn = sinon.fake.resolves({});
          const overrides = buildOverrides([withNoopWebClient()]);
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match
          const dummyReceiverEvents = createReceiverEvents();

          // Act
          const fakeLogger = createFakeLogger();
          const app = new App({
            logger: fakeLogger,
            receiver: fakeReceiver,
            authorize: sinon.fake.resolves(dummyAuthorizationResult),
          });

          app.use(async ({ next }) => {
            await ackFn();
            await next!();
          });
          app.shortcut({ callback_id: 'message_action_callback_id' }, async ({}) => {
            await shortcutFn();
          });
          app.shortcut({ type: 'message_action', callback_id: 'another_message_action_callback_id' }, async ({}) => {
            await shortcutFn();
          });
          app.shortcut({ type: 'message_action', callback_id: 'does_not_exist' }, async ({}) => {
            await shortcutFn();
          });
          app.shortcut({ callback_id: 'shortcut_callback_id' }, async ({}) => {
            await shortcutFn();
          });
          app.shortcut({ type: 'shortcut', callback_id: 'another_shortcut_callback_id' }, async ({}) => {
            await shortcutFn();
          });
          app.shortcut({ type: 'shortcut', callback_id: 'does_not_exist' }, async ({}) => {
            await shortcutFn();
          });
          app.action('block_action_id', async ({}) => {
            await actionFn();
          });
          app.action({ callback_id: 'interactive_message_callback_id' }, async ({}) => {
            await actionFn();
          });
          app.action({ callback_id: 'dialog_submission_callback_id' }, async ({}) => {
            await actionFn();
          });
          app.view('view_callback_id', async ({}) => {
            await viewFn();
          });
          app.view({ callback_id: 'view_callback_id', type: 'view_closed' }, async ({}) => {
            await viewFn();
          });
          app.options('external_select_action_id', async ({}) => {
            await optionsFn();
          });
          app.options({ callback_id: 'dialog_suggestion_callback_id' }, async ({}) => {
            await optionsFn();
          });

          app.event('app_home_opened', async ({}) => {
            /* noop */
          });

          app.event(/app_home_opened|app_mention/, async ({}) => {
            /* noop */
          });

          app.message('hello', async ({}) => {
            /* noop */
          });
          app.command('/echo', async ({}) => {
            /* noop */
          });
          app.command(/\/e.*/, async ({}) => {
            /* noop */
          });

          // invalid view constraints
          const invalidViewConstraints1 = {
            callback_id: 'foo',
            type: 'view_submission',
            unknown_key: 'should be detected',
          } as any as ViewConstraints;
          app.view(invalidViewConstraints1, async ({}) => {
            /* noop */
          });
          assert.isTrue(fakeLogger.error.called);

          fakeLogger.error = sinon.fake();

          const invalidViewConstraints2 = {
            callback_id: 'foo',
            type: undefined,
            unknown_key: 'should be detected',
          } as any as ViewConstraints;
          app.view(invalidViewConstraints2, async ({}) => {
            /* noop */
          });
          assert.isTrue(fakeLogger.error.called);

          app.error(fakeErrorHandler);
          await Promise.all(dummyReceiverEvents.map((event) => fakeReceiver.sendEvent(event)));

          // Assert
          assert.equal(actionFn.callCount, 3);
          assert.equal(shortcutFn.callCount, 4);
          assert.equal(viewFn.callCount, 5);
          assert.equal(optionsFn.callCount, 2);
          assert.equal(ackFn.callCount, dummyReceiverEvents.length);
          assert(fakeErrorHandler.notCalled);
        });

        // This test confirms authorize is being used for org events
        it('should acknowledge any possible org events', async () => {
          // Arrange
          const ackFn = sinon.fake.resolves({});
          const actionFn = sinon.fake.resolves({});
          const shortcutFn = sinon.fake.resolves({});
          const viewFn = sinon.fake.resolves({});
          const optionsFn = sinon.fake.resolves({});
          const overrides = buildOverrides([withNoopWebClient()]);
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match
          const dummyReceiverEvents = createOrgAppReceiverEvents();

          // Act
          const fakeLogger = createFakeLogger();
          const app = new App({
            logger: fakeLogger,
            receiver: fakeReceiver,
            authorize: sinon.fake.resolves(dummyAuthorizationResult),
          });

          app.use(async ({ next }) => {
            await ackFn();
            await next!();
          });
          app.shortcut({ callback_id: 'message_action_callback_id' }, async ({}) => {
            await shortcutFn();
          });
          app.shortcut({ type: 'message_action', callback_id: 'another_message_action_callback_id' }, async ({}) => {
            await shortcutFn();
          });
          app.shortcut({ type: 'message_action', callback_id: 'does_not_exist' }, async ({}) => {
            await shortcutFn();
          });
          app.shortcut({ callback_id: 'shortcut_callback_id' }, async ({}) => {
            await shortcutFn();
          });
          app.shortcut({ type: 'shortcut', callback_id: 'another_shortcut_callback_id' }, async ({}) => {
            await shortcutFn();
          });
          app.shortcut({ type: 'shortcut', callback_id: 'does_not_exist' }, async ({}) => {
            await shortcutFn();
          });
          app.action('block_action_id', async ({}) => {
            await actionFn();
          });
          app.action({ callback_id: 'interactive_message_callback_id' }, async ({}) => {
            await actionFn();
          });
          app.action({ callback_id: 'dialog_submission_callback_id' }, async ({}) => {
            await actionFn();
          });
          app.view('view_callback_id', async ({}) => {
            await viewFn();
          });
          app.view({ callback_id: 'view_callback_id', type: 'view_closed' }, async ({}) => {
            await viewFn();
          });
          app.options('external_select_action_id', async ({}) => {
            await optionsFn();
          });
          app.options({ callback_id: 'dialog_suggestion_callback_id' }, async ({}) => {
            await optionsFn();
          });

          app.event('app_home_opened', async ({}) => {
            /* noop */
          });
          app.message('hello', async ({}) => {
            /* noop */
          });
          app.command('/echo', async ({}) => {
            /* noop */
          });

          // invalid view constraints
          const invalidViewConstraints1 = {
            callback_id: 'foo',
            type: 'view_submission',
            unknown_key: 'should be detected',
          } as any as ViewConstraints;
          app.view(invalidViewConstraints1, async ({}) => {
            /* noop */
          });
          assert.isTrue(fakeLogger.error.called);

          fakeLogger.error = sinon.fake();

          const invalidViewConstraints2 = {
            callback_id: 'foo',
            type: undefined,
            unknown_key: 'should be detected',
          } as any as ViewConstraints;
          app.view(invalidViewConstraints2, async ({}) => {
            /* noop */
          });
          assert.isTrue(fakeLogger.error.called);

          app.error(fakeErrorHandler);
          await Promise.all(dummyReceiverEvents.map((event) => fakeReceiver.sendEvent(event)));

          // Assert
          assert.equal(actionFn.callCount, 3);
          assert.equal(shortcutFn.callCount, 4);
          assert.equal(viewFn.callCount, 2);
          assert.equal(optionsFn.callCount, 2);
          assert.equal(ackFn.callCount, dummyReceiverEvents.length);
          assert(fakeErrorHandler.notCalled);
        });
      });

      describe('command()', () => {
        it('should respond to exact name matches', async () => {
          // Arrange
          const overrides = buildOverrides([withNoopWebClient()]);
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match
          let matchCount = 0;

          // Act
          const app = new App({ receiver: fakeReceiver, authorize: sinon.fake.resolves(dummyAuthorizationResult) });
          app.command('/hello', async () => {
            ++matchCount;
          });
          await fakeReceiver.sendEvent({
            body: {
              type: 'slash_command',
              command: '/hello',
            },
            ack: noop,
          });

          // Assert
          assert.equal(matchCount, 1);
        });

        it('should respond to pattern matches', async () => {
          // Arrange
          const overrides = buildOverrides([withNoopWebClient()]);
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match
          let matchCount = 0;

          // Act
          const app = new App({ receiver: fakeReceiver, authorize: sinon.fake.resolves(dummyAuthorizationResult) });
          app.command(/h.*/, async () => {
            ++matchCount;
          });
          await fakeReceiver.sendEvent({
            body: {
              type: 'slash_command',
              command: '/hello',
            },
            ack: noop,
          });

          // Assert
          assert.equal(matchCount, 1);
        });

        it('should run all matching listeners', async () => {
          // Arrange
          const overrides = buildOverrides([withNoopWebClient()]);
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match
          let firstCount = 0;
          let secondCount = 0;

          // Act
          const app = new App({ receiver: fakeReceiver, authorize: sinon.fake.resolves(dummyAuthorizationResult) });
          app.command(/h.*/, async () => {
            ++firstCount;
          });
          app.command(/he.*/, async () => {
            ++secondCount;
          });
          await fakeReceiver.sendEvent({
            body: {
              type: 'slash_command',
              command: '/hello',
            },
            ack: noop,
          });

          // Assert
          assert.equal(firstCount, 1);
          assert.equal(secondCount, 1);
        });

        it('should not stop at an unsuccessful match', async () => {
          // Arrange
          const overrides = buildOverrides([withNoopWebClient()]);
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match
          let firstCount = 0;
          let secondCount = 0;

          // Act
          const app = new App({ receiver: fakeReceiver, authorize: sinon.fake.resolves(dummyAuthorizationResult) });
          app.command(/x.*/, async () => {
            ++firstCount;
          });
          app.command(/h.*/, async () => {
            ++secondCount;
          });
          await fakeReceiver.sendEvent({
            body: {
              type: 'slash_command',
              command: '/hello',
            },
            ack: noop,
          });

          // Assert
          assert.equal(firstCount, 0);
          assert.equal(secondCount, 1);
        });
      });

      describe('respond()', () => {
        it('should respond to events with a response_url', async () => {
          // Arrange
          const responseText = 'response';
          const responseUrl = 'https://fake.slack/response_url';
          const actionId = 'block_action_id';
          const fakeAxiosPost = sinon.fake.resolves({});
          const overrides = buildOverrides([withNoopWebClient(), withAxiosPost(fakeAxiosPost)]);
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

          // Act
          const app = new App({ receiver: fakeReceiver, authorize: sinon.fake.resolves(dummyAuthorizationResult) });
          app.action(actionId, async ({ respond }) => {
            await respond(responseText);
          });
          app.error(fakeErrorHandler);
          await fakeReceiver.sendEvent({
            // IncomingEventType.Action (app.action)
            body: {
              type: 'block_actions',
              response_url: responseUrl,
              actions: [
                {
                  action_id: actionId,
                },
              ],
              channel: {},
              user: {},
              team: {},
            },
            ack: noop,
          });

          // Assert
          assert(fakeErrorHandler.notCalled);
          assert.equal(fakeAxiosPost.callCount, 1);
          // Assert that each call to fakeAxiosPost had the right arguments
          assert(fakeAxiosPost.calledWith(responseUrl, { text: responseText }));
        });

        it('should respond with a response object', async () => {
          // Arrange
          const responseObject = { text: 'response' };
          const responseUrl = 'https://fake.slack/response_url';
          const actionId = 'block_action_id';
          const fakeAxiosPost = sinon.fake.resolves({});
          const overrides = buildOverrides([withNoopWebClient(), withAxiosPost(fakeAxiosPost)]);
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

          // Act
          const app = new App({ receiver: fakeReceiver, authorize: sinon.fake.resolves(dummyAuthorizationResult) });
          app.action(actionId, async ({ respond }) => {
            await respond(responseObject);
          });
          app.error(fakeErrorHandler);
          await fakeReceiver.sendEvent({
            // IncomingEventType.Action (app.action)
            body: {
              type: 'block_actions',
              response_url: responseUrl,
              actions: [
                {
                  action_id: actionId,
                },
              ],
              channel: {},
              user: {},
              team: {},
            },
            ack: noop,
          });

          // Assert
          assert.equal(fakeAxiosPost.callCount, 1);
          // Assert that each call to fakeAxiosPost had the right arguments
          assert(fakeAxiosPost.calledWith(responseUrl, responseObject));
        });
        it('should be able to use respond for view_submission payloads', async () => {
          // Arrange
          const responseObject = { text: 'response' };
          const responseUrl = 'https://fake.slack/response_url';
          const fakeAxiosPost = sinon.fake.resolves({});
          const overrides = buildOverrides([withNoopWebClient(), withAxiosPost(fakeAxiosPost)]);
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

          // Act
          const app = new App({ receiver: fakeReceiver, authorize: sinon.fake.resolves(dummyAuthorizationResult) });
          app.view('view-id', async ({ respond }) => {
            await respond(responseObject);
          });
          app.error(fakeErrorHandler);
          await fakeReceiver.sendEvent({
            ack: noop,
            body: {
              type: 'view_submission',
              team: {},
              user: {},
              view: {
                id: 'V111',
                type: 'modal',
                callback_id: 'view-id',
                state: {},
                title: {},
                close: {},
                submit: {},
              },
              response_urls: [
                {
                  block_id: 'b',
                  action_id: 'a',
                  channel_id: 'C111',
                  response_url: 'https://fake.slack/response_url',
                },
              ],
            },
          });

          // Assert
          assert.equal(fakeAxiosPost.callCount, 1);
          // Assert that each call to fakeAxiosPost had the right arguments
          assert(fakeAxiosPost.calledWith(responseUrl, responseObject));
        });
      });

      describe('logger', () => {
        it('should be available in middleware/listener args', async () => {
          // Arrange
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match
          const fakeLogger = createFakeLogger();
          const app = new App({
            logger: fakeLogger,
            receiver: fakeReceiver,
            authorize: sinon.fake.resolves(dummyAuthorizationResult),
          });
          app.use(async ({ logger, body, next }) => {
            logger.info(body);
            await next!();
          });

          app.event('app_home_opened', async ({ logger, event }) => {
            logger.debug(event);
          });

          const receiverEvents = [
            {
              body: {
                type: 'event_callback',
                token: 'XXYYZZ',
                team_id: 'TXXXXXXXX',
                api_app_id: 'AXXXXXXXXX',
                event: {
                  type: 'app_home_opened',
                  event_ts: '1234567890.123456',
                  user: 'UXXXXXXX1',
                  text: 'hello friends!',
                  tab: 'home',
                  view: {},
                },
              },
              respond: noop,
              ack: noop,
            },
          ];

          // Act
          await Promise.all(receiverEvents.map((event) => fakeReceiver.sendEvent(event)));

          // Assert
          assert.isTrue(fakeLogger.info.called);
          assert.isTrue(fakeLogger.debug.called);
        });

        it('should work in the case both logger and logLevel are given', async () => {
          // Arrange
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match
          const fakeLogger = createFakeLogger();
          const app = new App({
            logger: fakeLogger,
            logLevel: LogLevel.DEBUG,
            receiver: fakeReceiver,
            authorize: sinon.fake.resolves(dummyAuthorizationResult),
          });
          app.use(async ({ logger, body, next }) => {
            logger.info(body);
            await next!();
          });

          app.event('app_home_opened', async ({ logger, event }) => {
            logger.debug(event);
          });

          const receiverEvents = [
            {
              body: {
                type: 'event_callback',
                token: 'XXYYZZ',
                team_id: 'TXXXXXXXX',
                api_app_id: 'AXXXXXXXXX',
                event: {
                  type: 'app_home_opened',
                  event_ts: '1234567890.123456',
                  user: 'UXXXXXXX1',
                  text: 'hello friends!',
                  tab: 'home',
                  view: {},
                },
              },
              respond: noop,
              ack: noop,
            },
          ];

          // Act
          await Promise.all(receiverEvents.map((event) => fakeReceiver.sendEvent(event)));

          // Assert
          assert.isTrue(fakeLogger.info.called);
          assert.isTrue(fakeLogger.debug.called);
          assert.isTrue(fakeLogger.setLevel.called);
        });
      });

      describe('client', () => {
        it('should be available in middleware/listener args', async () => {
          // Arrange
          // eslint-disable-next-line  @typescript-eslint/naming-convention
          const App = await importApp(
            mergeOverrides(
              // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match
              withNoopAppMetadata(),
              withSuccessfulBotUserFetchingWebClient('B123', 'U123'),
            ),
          );
          const tokens = ['xoxb-123', 'xoxp-456', 'xoxb-123'];
          const app = new App({
            receiver: fakeReceiver,
            authorize: () => {
              const token = tokens.pop();
              if (typeof token === 'undefined') {
                return Promise.resolve({ botId: 'B123' });
              }
              if (token.startsWith('xoxb-')) {
                return Promise.resolve({ botToken: token, botId: 'B123' });
              }
              return Promise.resolve({ userToken: token, botId: 'B123' });
            },
          });
          app.use(async ({ client, next }) => {
            await client.auth.test();
            await next!();
          });
          const clients: WebClient[] = [];
          app.event('app_home_opened', async ({ client }) => {
            clients.push(client);
            await client.auth.test();
          });

          const event = {
            body: {
              type: 'event_callback',
              token: 'legacy',
              team_id: 'T123',
              api_app_id: 'A123',
              event: {
                type: 'app_home_opened',
                event_ts: '123.123',
                user: 'U123',
                text: 'Hi there!',
                tab: 'home',
                view: {},
              },
            },
            respond: noop,
            ack: noop,
          };
          const receiverEvents = [event, event, event];

          // Act
          await Promise.all(receiverEvents.map((event) => fakeReceiver.sendEvent(event)));

          // Assert
          assert.isUndefined(app.client.token);

          assert.equal(clients[0].token, 'xoxb-123');
          assert.equal(clients[1].token, 'xoxp-456');
          assert.equal(clients[2].token, 'xoxb-123');

          assert.notEqual(clients[0], clients[1]);
          assert.strictEqual(clients[0], clients[2]);
        });

        it("should be to the global app client when authorization doesn't produce a token", async () => {
          // Arrange
          const App = await importApp(); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match
          const app = new App({
            receiver: fakeReceiver,
            authorize: noopAuthorize,
            ignoreSelf: false,
          });
          const globalClient = app.client;

          // Act
          let clientArg: WebClient | undefined;
          app.use(async ({ client }) => {
            clientArg = client;
          });
          await fakeReceiver.sendEvent(createDummyReceiverEvent());

          // Assert
          assert.equal(globalClient, clientArg);
        });
      });

      describe('say()', () => {
        function createChannelContextualReceiverEvents(channelId: string): ReceiverEvent[] {
          return [
            // IncomingEventType.Event with channel in payload
            {
              ...baseEvent,
              body: {
                event: {
                  channel: channelId,
                },
                team_id: 'TEAM_ID',
              },
            },
            // IncomingEventType.Event with channel in item
            {
              ...baseEvent,
              body: {
                event: {
                  item: {
                    channel: channelId,
                  },
                },
                team_id: 'TEAM_ID',
              },
            },
            // IncomingEventType.Command
            {
              ...baseEvent,
              body: {
                command: '/COMMAND_NAME',
                channel_id: channelId,
                team_id: 'TEAM_ID',
              },
            },
            // IncomingEventType.Action from block action, interactive message, or message action
            {
              ...baseEvent,
              body: {
                actions: [{}],
                channel: {
                  id: channelId,
                },
                user: {
                  id: 'USER_ID',
                },
                team: {
                  id: 'TEAM_ID',
                },
              },
            },
            // IncomingEventType.Action from dialog submission
            {
              ...baseEvent,
              body: {
                type: 'dialog_submission',
                channel: {
                  id: channelId,
                },
                user: {
                  id: 'USER_ID',
                },
                team: {
                  id: 'TEAM_ID',
                },
              },
            },
          ];
        }

        it('should send a simple message to a channel where the incoming event originates', async () => {
          // Arrange
          const fakePostMessage = sinon.fake.resolves({});
          const overrides = buildOverrides([withPostMessage(fakePostMessage)]);
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

          const dummyMessage = 'test';
          const dummyReceiverEvents = createChannelContextualReceiverEvents(dummyChannelId);

          // Act
          const app = new App({ receiver: fakeReceiver, authorize: sinon.fake.resolves(dummyAuthorizationResult) });
          app.use(async (args) => {
            // By definition, these events should all produce a say function, so we cast args.say into a SayFn
            const say = (args as any).say as SayFn;
            await say(dummyMessage);
          });
          app.error(fakeErrorHandler);
          await Promise.all(dummyReceiverEvents.map((event) => fakeReceiver.sendEvent(event)));

          // Assert
          assert.equal(fakePostMessage.callCount, dummyReceiverEvents.length);
          // Assert that each call to fakePostMessage had the right arguments
          fakePostMessage.getCalls().forEach((call) => {
            const firstArg = call.args[0];
            assert.propertyVal(firstArg, 'text', dummyMessage);
            assert.propertyVal(firstArg, 'channel', dummyChannelId);
          });
          assert(fakeErrorHandler.notCalled);
        });

        it('should send a complex message to a channel where the incoming event originates', async () => {
          // Arrange
          const fakePostMessage = sinon.fake.resolves({});
          const overrides = buildOverrides([withPostMessage(fakePostMessage)]);
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

          const dummyMessage = { text: 'test' };
          const dummyReceiverEvents = createChannelContextualReceiverEvents(dummyChannelId);

          // Act
          const app = new App({ receiver: fakeReceiver, authorize: sinon.fake.resolves(dummyAuthorizationResult) });
          app.use(async (args) => {
            // By definition, these events should all produce a say function, so we cast args.say into a SayFn
            const say = (args as any).say as SayFn;
            await say(dummyMessage);
          });
          app.error(fakeErrorHandler);
          await Promise.all(dummyReceiverEvents.map((event) => fakeReceiver.sendEvent(event)));

          // Assert
          assert.equal(fakePostMessage.callCount, dummyReceiverEvents.length);
          // Assert that each call to fakePostMessage had the right arguments
          fakePostMessage.getCalls().forEach((call) => {
            const firstArg = call.args[0];
            assert.propertyVal(firstArg, 'channel', dummyChannelId);
            for (const prop in dummyMessage) {
              assert.propertyVal(firstArg, prop, (dummyMessage as any)[prop]);
            }
          });
          assert(fakeErrorHandler.notCalled);
        });

        function createReceiverEventsWithoutSay(channelId: string): ReceiverEvent[] {
          return [
            // IncomingEventType.Options from block action
            {
              ...baseEvent,
              body: {
                type: 'block_suggestion',
                channel: {
                  id: channelId,
                },
                user: {
                  id: 'USER_ID',
                },
                team: {
                  id: 'TEAM_ID',
                },
              },
            },
            // IncomingEventType.Options from interactive message or dialog
            {
              ...baseEvent,
              body: {
                name: 'select_field_name',
                channel: {
                  id: channelId,
                },
                user: {
                  id: 'USER_ID',
                },
                team: {
                  id: 'TEAM_ID',
                },
              },
            },
            // IncomingEventType.Event without a channel context
            {
              ...baseEvent,
              body: {
                event: {},
                team_id: 'TEAM_ID',
              },
            },
          ];
        }

        it("should not exist in the arguments on incoming events that don't support say", async () => {
          // Arrange
          const overrides = buildOverrides([withNoopWebClient()]);
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

          const assertionAggregator = sinon.fake();
          const dummyReceiverEvents = createReceiverEventsWithoutSay(dummyChannelId);

          // Act
          const app = new App({ receiver: fakeReceiver, authorize: sinon.fake.resolves(dummyAuthorizationResult) });
          app.use(async (args) => {
            assert.isUndefined((args as any).say);
            // If the above assertion fails, then it would throw an AssertionError and the following line will not be
            // called
            assertionAggregator();
          });

          await Promise.all(dummyReceiverEvents.map((event) => fakeReceiver.sendEvent(event)));

          // Assert
          assert.equal(assertionAggregator.callCount, dummyReceiverEvents.length);
        });

        it("should handle failures through the App's global error handler", async () => {
          // Arrange
          const fakePostMessage = sinon.fake.rejects(new Error('fake error'));
          const overrides = buildOverrides([withPostMessage(fakePostMessage)]);
          const App = await importApp(overrides); // eslint-disable-line  @typescript-eslint/naming-convention, no-underscore-dangle, id-blacklist, id-match

          const dummyMessage = { text: 'test' };
          const dummyReceiverEvents = createChannelContextualReceiverEvents(dummyChannelId);

          // Act
          const app = new App({ receiver: fakeReceiver, authorize: sinon.fake.resolves(dummyAuthorizationResult) });
          app.use(async (args) => {
            // By definition, these events should all produce a say function, so we cast args.say into a SayFn
            const say = (args as any).say as SayFn;
            await say(dummyMessage);
          });
          app.error(fakeErrorHandler);
          await Promise.all(dummyReceiverEvents.map((event) => fakeReceiver.sendEvent(event)));

          // Assert
          assert.equal(fakeErrorHandler.callCount, dummyReceiverEvents.length);
        });
      });
    });
  });
});

/* Testing Harness */

// Loading the system under test using overrides
async function importApp(
  overrides: Override = mergeOverrides(withNoopAppMetadata(), withNoopWebClient()),
): Promise<typeof import('./App').default> {
  return (await rewiremock.module(() => import('./App'), overrides)).default;
}

// Composable overrides
function withNoopWebClient(): Override {
  return {
    '@slack/web-api': {
      WebClient: class {},
    },
  };
}

function withNoopAppMetadata(): Override {
  return {
    '@slack/web-api': {
      addAppMetadata: sinon.fake(),
    },
  };
}

function withSuccessfulBotUserFetchingWebClient(botId: string, botUserId: string): Override {
  return {
    '@slack/web-api': {
      WebClient: class {
        public token?: string;
        constructor(token?: string, _options?: WebClientOptions) {
          this.token = token;
        }
        public auth = {
          test: sinon.fake.resolves({ user_id: botUserId }),
        };
        public users = {
          info: sinon.fake.resolves({
            user: {
              profile: {
                bot_id: botId,
              },
            },
          }),
        };
      },
    },
  };
}

function withPostMessage(spy: SinonSpy): Override {
  return {
    '@slack/web-api': {
      WebClient: class {
        public chat = {
          postMessage: spy,
        };
      },
    },
  };
}

function withAxiosPost(spy: SinonSpy): Override {
  return {
    axios: {
      create: () => ({
        post: spy,
      }),
    },
  };
}

function withMemoryStore(spy: SinonSpy): Override {
  return {
    './conversation-store': {
      MemoryStore: spy,
    },
  };
}

function withConversationContext(spy: SinonSpy): Override {
  return {
    './conversation-store': {
      conversationContext: spy,
    },
  };
}

// Fakes
class FakeReceiver implements Receiver {
  private bolt: App | undefined;

  public init = (bolt: App) => {
    this.bolt = bolt;
  };

  public start = sinon.fake((...params: any[]): Promise<unknown> => {
    return Promise.resolve([...params]);
  });

  public stop = sinon.fake((...params: any[]): Promise<unknown> => {
    return Promise.resolve([...params]);
  });

  public async sendEvent(event: ReceiverEvent): Promise<void> {
    return this.bolt?.processEvent(event);
  }
}
