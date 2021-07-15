/* eslint-disable @typescript-eslint/explicit-member-accessibility, @typescript-eslint/strict-boolean-expressions */
import { Agent } from 'http';
import { SecureContextOptions } from 'tls';
import util from 'util';
import { WebClient, ChatPostMessageArguments, addAppMetadata, WebClientOptions } from '@slack/web-api';
import { Logger, LogLevel, ConsoleLogger } from '@slack/logger';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import SocketModeReceiver from './receivers/SocketModeReceiver';
import HTTPReceiver, { HTTPReceiverOptions } from './receivers/HTTPReceiver';
import {
  ignoreSelf as ignoreSelfMiddleware,
  onlyActions,
  matchConstraints,
  onlyCommands,
  matchCommandName,
  onlyOptions,
  onlyShortcuts,
  onlyEvents,
  matchEventType,
  matchMessage,
  onlyViewActions,
} from './middleware/builtin';
import { processMiddleware } from './middleware/process';
import { ConversationStore, conversationContext, MemoryStore } from './conversation-store';
import { WorkflowStep } from './WorkflowStep';
import {
  Middleware,
  AnyMiddlewareArgs,
  SlackActionMiddlewareArgs,
  SlackCommandMiddlewareArgs,
  SlackEventMiddlewareArgs,
  SlackSubtypedEventMiddlewareArgs,
  SlackOptionsMiddlewareArgs,
  SlackShortcutMiddlewareArgs,
  SlackViewMiddlewareArgs,
  SlackAction,
  EventTypePattern,
  SlackShortcut,
  Context,
  SayFn,
  AckFn,
  RespondFn,
  OptionsSource,
  BlockAction,
  InteractiveMessage,
  SlackViewAction,
  Receiver,
  ReceiverEvent,
  RespondArguments,
} from './types';
import { IncomingEventType, getTypeAndConversation, assertNever } from './helpers';
import { CodedError, asCodedError, AppInitializationError, MultipleListenerError } from './errors';
// eslint-disable-next-line import/order
import allSettled = require('promise.allsettled'); // eslint-disable-line @typescript-eslint/no-require-imports
// eslint-disable-next-line @typescript-eslint/no-require-imports
const packageJson = require('../package.json'); // eslint-disable-line @typescript-eslint/no-var-requires

/** App initialization options */
export interface AppOptions {
  signingSecret?: HTTPReceiverOptions['signingSecret'];
  endpoints?: HTTPReceiverOptions['endpoints'];
  processBeforeResponse?: HTTPReceiverOptions['processBeforeResponse'];
  clientId?: HTTPReceiverOptions['clientId'];
  clientSecret?: HTTPReceiverOptions['clientSecret'];
  stateSecret?: HTTPReceiverOptions['stateSecret']; // required when using default stateStore
  installationStore?: HTTPReceiverOptions['installationStore']; // default MemoryInstallationStore
  scopes?: HTTPReceiverOptions['scopes'];
  installerOptions?: HTTPReceiverOptions['installerOptions'];
  agent?: Agent;
  clientTls?: Pick<SecureContextOptions, 'pfx' | 'key' | 'passphrase' | 'cert' | 'ca'>;
  convoStore?: ConversationStore | false;
  token?: AuthorizeResult['botToken']; // either token or authorize
  appToken?: string; // TODO should this be included in AuthorizeResult
  botId?: AuthorizeResult['botId']; // only used when authorize is not defined, shortcut for fetching
  botUserId?: AuthorizeResult['botUserId']; // only used when authorize is not defined, shortcut for fetching
  authorize?: Authorize<boolean>; // either token or authorize
  receiver?: Receiver;
  logger?: Logger;
  logLevel?: LogLevel;
  ignoreSelf?: boolean;
  clientOptions?: Pick<WebClientOptions, 'slackApiUrl'>;
  socketMode?: boolean;
  developerMode?: boolean;
  tokenVerificationEnabled?: boolean;
}

export { LogLevel, Logger } from '@slack/logger';

/** Authorization function - seeds the middleware processing and listeners with an authorization context */
export interface Authorize<IsEnterpriseInstall extends boolean = false> {
  (source: AuthorizeSourceData<IsEnterpriseInstall>, body?: AnyMiddlewareArgs['body']): Promise<AuthorizeResult>;
}

/** Authorization function inputs - authenticated data about an event for the authorization function */
export interface AuthorizeSourceData<IsEnterpriseInstall extends boolean = false> {
  teamId: IsEnterpriseInstall extends true ? string | undefined : string;
  enterpriseId: IsEnterpriseInstall extends true ? string : string | undefined;
  userId?: string;
  conversationId?: string;
  isEnterpriseInstall: IsEnterpriseInstall;
}

/** Authorization function outputs - data that will be available as part of event processing */
export interface AuthorizeResult {
  // one of either botToken or userToken are required
  botToken?: string; // used by `say` (preferred over userToken)
  userToken?: string; // used by `say` (overridden by botToken)
  botId?: string; // required for `ignoreSelf` global middleware
  botUserId?: string; // optional but allows `ignoreSelf` global middleware be more filter more than just message events
  teamId?: string;
  enterpriseId?: string;
  [key: string]: any;
}

export interface ActionConstraints<A extends SlackAction = SlackAction> {
  type?: A['type'];
  block_id?: A extends BlockAction ? string | RegExp : never;
  action_id?: A extends BlockAction ? string | RegExp : never;
  callback_id?: Extract<A, { callback_id?: string }> extends any ? string | RegExp : never;
}

export interface ShortcutConstraints<S extends SlackShortcut = SlackShortcut> {
  type?: S['type'];
  callback_id?: string | RegExp;
}

export interface ViewConstraints {
  callback_id?: string | RegExp;
  type?: 'view_closed' | 'view_submission';
}

export interface ErrorHandler {
  (error: CodedError): Promise<void>;
}

class WebClientPool {
  private pool: { [token: string]: WebClient } = {};

  public getOrCreate(token: string, clientOptions: WebClientOptions): WebClient {
    const cachedClient = this.pool[token];
    if (typeof cachedClient !== 'undefined') {
      return cachedClient;
    }
    const client = new WebClient(token, clientOptions);
    this.pool[token] = client;
    return client;
  }
}

/**
 * A Slack App
 */
export default class App {
  /** Slack Web API client */
  public client: WebClient;

  private clientOptions: WebClientOptions;

  // Some payloads don't have teamId anymore. So we use EnterpriseId in those scenarios
  private clients: { [teamOrEnterpriseId: string]: WebClientPool } = {};

  /** Receiver - ingests events from the Slack platform */
  private receiver: Receiver;

  /** Logger */
  private logger: Logger;

  /** Log Level */
  private logLevel: LogLevel;

  /** Authorize */
  private authorize!: Authorize<boolean>;

  /** Global middleware chain */
  private middleware: Middleware<AnyMiddlewareArgs>[];

  /** Listener middleware chains */
  private listeners: Middleware<AnyMiddlewareArgs>[][];

  private errorHandler: ErrorHandler;

  private axios: AxiosInstance;

  private installerOptions: HTTPReceiverOptions['installerOptions'];

  private socketMode: boolean;

  private developerMode: boolean;

  constructor({
    signingSecret = undefined,
    endpoints = undefined,
    agent = undefined,
    clientTls = undefined,
    receiver = undefined,
    convoStore = undefined,
    token = undefined,
    appToken = undefined,
    botId = undefined,
    botUserId = undefined,
    authorize = undefined,
    logger = undefined,
    logLevel = undefined,
    ignoreSelf = true,
    clientOptions = undefined,
    processBeforeResponse = false,
    clientId = undefined,
    clientSecret = undefined,
    stateSecret = undefined,
    installationStore = undefined,
    scopes = undefined,
    installerOptions = undefined,
    socketMode = undefined,
    developerMode = false,
    tokenVerificationEnabled = true,
  }: AppOptions = {}) {
    // this.logLevel = logLevel;
    this.developerMode = developerMode;
    if (developerMode) {
      // Set logLevel to Debug in Developer Mode if one wasn't passed in
      this.logLevel = logLevel ?? LogLevel.DEBUG;
      // Set SocketMode to true if one wasn't passed in
      this.socketMode = socketMode ?? true;
    } else {
      // If devs aren't using Developer Mode or Socket Mode, set it to false
      this.socketMode = socketMode ?? false;
      // Set logLevel to Info if one wasn't passed in
      this.logLevel = logLevel ?? LogLevel.INFO;
    }

    if (typeof logger === 'undefined') {
      // Initialize with the default logger
      const consoleLogger = new ConsoleLogger();
      consoleLogger.setName('bolt-app');
      this.logger = consoleLogger;
    } else {
      this.logger = logger;
    }
    if (typeof this.logLevel !== 'undefined' && this.logger.getLevel() !== this.logLevel) {
      this.logger.setLevel(this.logLevel);
    }
    this.errorHandler = defaultErrorHandler(this.logger);

    this.clientOptions = clientOptions !== undefined ? clientOptions : {};
    if (agent !== undefined && this.clientOptions.agent === undefined) {
      this.clientOptions.agent = agent;
    }
    if (clientTls !== undefined && this.clientOptions.tls === undefined) {
      this.clientOptions.tls = clientTls;
    }
    if (logLevel !== undefined && logger === undefined) {
      // only logLevel is passed
      this.clientOptions.logLevel = logLevel;
    } else {
      if (logLevel !== undefined) {
        // If the constructor has both, logLevel is ignored
        this.logger.warn(
          "As `logger` is passed as well, `logLevel` argument won't be used. Set the log level to the `logger` instance instead.",
        );
      }
      // Since v3.4, WebClient starts sharing loggger with App
      this.clientOptions.logger = this.logger;
    }
    // The public WebClient instance (app.client)
    // Since v3.4, it can have the passed token in the case of single workspace installation.
    this.client = new WebClient(token, this.clientOptions);

    this.axios = axios.create({
      httpAgent: agent,
      httpsAgent: agent,
      // disabling axios' automatic proxy support:
      // axios would read from envvars to configure a proxy automatically, but it doesn't support TLS destinations.
      // for compatibility with https://api.slack.com, and for a larger set of possible proxies (SOCKS or other
      // protocols), users of this package should use the `agent` option to configure a proxy.
      proxy: false,
      ...clientTls,
    });

    this.middleware = [];
    this.listeners = [];

    // Add clientOptions to InstallerOptions to pass them to @slack/oauth
    this.installerOptions = {
      clientOptions: this.clientOptions,
      ...installerOptions,
    };

    if (
      this.developerMode &&
      this.installerOptions &&
      (typeof this.installerOptions.callbackOptions === 'undefined' ||
        (typeof this.installerOptions.callbackOptions !== 'undefined' &&
          typeof this.installerOptions.callbackOptions.failure === 'undefined'))
    ) {
      // add a custom failure callback for Developer Mode in case they are using OAuth
      this.logger.debug('adding Developer Mode custom OAuth failure handler');
      this.installerOptions.callbackOptions = {
        failure: (error, _installOptions, _req, res) => {
          this.logger.debug(error);
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h1>OAuth failed!</h1><div>${error}</div></body></html>`);
        },
      };
    }

    // Check for required arguments of HTTPReceiver
    if (receiver !== undefined) {
      this.receiver = receiver;
    } else if (this.socketMode) {
      if (appToken === undefined) {
        throw new AppInitializationError('You must provide an appToken when using Socket Mode');
      }
      this.logger.debug('Initializing SocketModeReceiver');
      // Create default SocketModeReceiver
      this.receiver = new SocketModeReceiver({
        appToken,
        clientId,
        clientSecret,
        stateSecret,
        installationStore,
        scopes,
        logger,
        logLevel: this.logLevel,
        installerOptions: this.installerOptions,
      });
    } else if (signingSecret === undefined) {
      // No custom receiver
      throw new AppInitializationError(
        'Signing secret not found, so could not initialize the default receiver. Set a signing secret or use a ' +
          'custom receiver.',
      );
    } else {
      this.logger.debug('Initializing HTTPReceiver');
      // Create default HTTPReceiver
      this.receiver = new HTTPReceiver({
        signingSecret,
        endpoints,
        processBeforeResponse,
        clientId,
        clientSecret,
        stateSecret,
        installationStore,
        scopes,
        logger,
        logLevel: this.logLevel,
        installerOptions: this.installerOptions,
      });
    }

    let usingOauth = false;
    if (
      (this.receiver as HTTPReceiver).installer !== undefined &&
      (this.receiver as HTTPReceiver).installer!.authorize !== undefined
    ) {
      // This supports using the built in HTTPReceiver, declaring your own HTTPReceiver
      // and theoretically, doing a fully custom (non express) receiver that implements OAuth
      usingOauth = true;
    }

    if (token !== undefined) {
      if (authorize !== undefined || usingOauth) {
        throw new AppInitializationError(
          `token as well as authorize or oauth installer options were provided. ${tokenUsage}`,
        );
      }
      this.authorize = singleAuthorization(
        this.client,
        {
          botId,
          botUserId,
          botToken: token,
        },
        tokenVerificationEnabled,
      );
    } else if (authorize === undefined && !usingOauth) {
      throw new AppInitializationError(
        `No token, no authorize, and no oauth installer options provided. ${tokenUsage}`,
      );
    } else if (authorize !== undefined && usingOauth) {
      throw new AppInitializationError(`Both authorize options and oauth installer options provided. ${tokenUsage}`);
    } else if (authorize === undefined && usingOauth) {
      this.authorize = (this.receiver as HTTPReceiver).installer!.authorize;
    } else if (authorize !== undefined && !usingOauth) {
      this.authorize = authorize;
    } else {
      this.logger.error('Never should have reached this point, please report to the team');
      assertNever();
    }

    // Conditionally use a global middleware that ignores events (including messages) that are sent from this app
    if (ignoreSelf) {
      this.use(ignoreSelfMiddleware());
    }

    // Use conversation state global middleware
    if (convoStore !== false) {
      // Use the memory store by default, or another store if provided
      const store: ConversationStore = convoStore === undefined ? new MemoryStore() : convoStore;
      this.use(conversationContext(store));
    }

    // Should be last to avoid exposing partially initialized app
    this.receiver.init(this);
  }

  /**
   * Register a new middleware, processed in the order registered.
   *
   * @param m global middleware function
   */
  public use(m: Middleware<AnyMiddlewareArgs>): this {
    this.middleware.push(m);
    return this;
  }

  /**
   * Register WorkflowStep middleware
   *
   * @param workflowStep global workflow step middleware function
   */
  public step(workflowStep: WorkflowStep): this {
    const m = workflowStep.getMiddleware();
    this.middleware.push(m);
    return this;
  }

  /**
   * Convenience method to call start on the receiver
   *
   * TODO: should replace HTTPReceiver in type definition with a generic that is constrained to Receiver
   *
   * @param args receiver-specific start arguments
   */
  public start(
    ...args: Parameters<HTTPReceiver['start'] | SocketModeReceiver['start']>
  ): ReturnType<HTTPReceiver['start']> {
    return this.receiver.start(...args) as ReturnType<HTTPReceiver['start']>;
  }

  public stop(...args: any[]): Promise<unknown> {
    return this.receiver.stop(...args);
  }

  public event<EventType extends string = string>(
    eventName: EventType,
    ...listeners: Middleware<SlackEventMiddlewareArgs<EventType>>[]
  ): void;
  public event<EventType extends RegExp = RegExp>(
    eventName: EventType,
    ...listeners: Middleware<SlackEventMiddlewareArgs<string>>[]
  ): void;
  public event<EventType extends EventTypePattern = EventTypePattern>(
    eventNameOrPattern: EventType,
    ...listeners: Middleware<SlackEventMiddlewareArgs<string>>[]
  ): void {
    let invalidEventName = false;
    if (typeof eventNameOrPattern === 'string') {
      const name = eventNameOrPattern as string;
      invalidEventName = name.startsWith('message.');
    } else if (eventNameOrPattern instanceof RegExp) {
      const name = (eventNameOrPattern as RegExp).source;
      invalidEventName = name.startsWith('message\\.');
    }
    if (invalidEventName) {
      throw new AppInitializationError(
        `Although the document mentions "${eventNameOrPattern}",` +
          'it is not a valid event type. Use "message" instead. ' +
          'If you want to filter message events, you can use event.channel_type for it.',
      );
    }
    this.listeners.push([
      onlyEvents,
      matchEventType(eventNameOrPattern),
      ...listeners,
    ] as Middleware<AnyMiddlewareArgs>[]);
  }

  // TODO: just make a type alias for Middleware<SlackEventMiddlewareArgs<'message'>>
  // TODO: maybe remove the first two overloads
  public message<Subtype extends string | undefined = '*'>(
    ...listeners: Middleware<SlackSubtypedEventMiddlewareArgs<'message', Subtype>>[]
  ): void;
  public message<Subtype extends string | undefined = '*'>(
    pattern: string | RegExp,
    ...listeners: Middleware<SlackSubtypedEventMiddlewareArgs<'message', Subtype>>[]
  ): void;
  public message<Subtype extends string | undefined = '*'>(
    ...patternsOrMiddleware: (string | RegExp | Middleware<SlackSubtypedEventMiddlewareArgs<'message', Subtype>>)[]
  ): void {
    const messageMiddleware = patternsOrMiddleware.map((patternOrMiddleware) => {
      if (typeof patternOrMiddleware === 'string' || util.types.isRegExp(patternOrMiddleware)) {
        return matchMessage(patternOrMiddleware);
      }
      return patternOrMiddleware;
    });

    this.listeners.push([
      onlyEvents,
      matchEventType('message'),
      ...messageMiddleware,
    ] as Middleware<AnyMiddlewareArgs>[]);
  }

  public shortcut<Shortcut extends SlackShortcut = SlackShortcut>(
    callbackId: string | RegExp,
    ...listeners: Middleware<SlackShortcutMiddlewareArgs<Shortcut>>[]
  ): void;
  public shortcut<
    Shortcut extends SlackShortcut = SlackShortcut,
    Constraints extends ShortcutConstraints<Shortcut> = ShortcutConstraints<Shortcut>,
  >(
    constraints: Constraints,
    ...listeners: Middleware<SlackShortcutMiddlewareArgs<Extract<Shortcut, { type: Constraints['type'] }>>>[]
  ): void;
  public shortcut<
    Shortcut extends SlackShortcut = SlackShortcut,
    Constraints extends ShortcutConstraints<Shortcut> = ShortcutConstraints<Shortcut>,
  >(
    callbackIdOrConstraints: string | RegExp | Constraints,
    ...listeners: Middleware<SlackShortcutMiddlewareArgs<Extract<Shortcut, { type: Constraints['type'] }>>>[]
  ): void {
    const constraints: ShortcutConstraints =
      typeof callbackIdOrConstraints === 'string' || util.types.isRegExp(callbackIdOrConstraints)
        ? { callback_id: callbackIdOrConstraints }
        : callbackIdOrConstraints;

    // Fail early if the constraints contain invalid keys
    const unknownConstraintKeys = Object.keys(constraints).filter((k) => k !== 'callback_id' && k !== 'type');
    if (unknownConstraintKeys.length > 0) {
      this.logger.error(
        `Slack listener cannot be attached using unknown constraint keys: ${unknownConstraintKeys.join(', ')}`,
      );
      return;
    }

    this.listeners.push([
      onlyShortcuts,
      matchConstraints(constraints),
      ...listeners,
    ] as Middleware<AnyMiddlewareArgs>[]);
  }

  // NOTE: this is what's called a convenience generic, so that types flow more easily without casting.
  // https://basarat.gitbooks.io/typescript/docs/types/generics.html#design-pattern-convenience-generic
  public action<Action extends SlackAction = SlackAction>(
    actionId: string | RegExp,
    ...listeners: Middleware<SlackActionMiddlewareArgs<Action>>[]
  ): void;
  public action<
    Action extends SlackAction = SlackAction,
    Constraints extends ActionConstraints<Action> = ActionConstraints<Action>,
  >(
    constraints: Constraints,
    // NOTE: Extract<> is able to return the whole union when type: undefined. Why?
    ...listeners: Middleware<SlackActionMiddlewareArgs<Extract<Action, { type: Constraints['type'] }>>>[]
  ): void;
  public action<
    Action extends SlackAction = SlackAction,
    Constraints extends ActionConstraints<Action> = ActionConstraints<Action>,
  >(
    actionIdOrConstraints: string | RegExp | Constraints,
    ...listeners: Middleware<SlackActionMiddlewareArgs<Extract<Action, { type: Constraints['type'] }>>>[]
  ): void {
    // Normalize Constraints
    const constraints: ActionConstraints =
      typeof actionIdOrConstraints === 'string' || util.types.isRegExp(actionIdOrConstraints)
        ? { action_id: actionIdOrConstraints }
        : actionIdOrConstraints;

    // Fail early if the constraints contain invalid keys
    const unknownConstraintKeys = Object.keys(constraints).filter(
      (k) => k !== 'action_id' && k !== 'block_id' && k !== 'callback_id' && k !== 'type',
    );
    if (unknownConstraintKeys.length > 0) {
      this.logger.error(
        `Action listener cannot be attached using unknown constraint keys: ${unknownConstraintKeys.join(', ')}`,
      );
      return;
    }

    this.listeners.push([onlyActions, matchConstraints(constraints), ...listeners] as Middleware<AnyMiddlewareArgs>[]);
  }

  public command(commandName: string | RegExp, ...listeners: Middleware<SlackCommandMiddlewareArgs>[]): void {
    this.listeners.push([onlyCommands, matchCommandName(commandName), ...listeners] as Middleware<AnyMiddlewareArgs>[]);
  }

  public options<Source extends OptionsSource = 'block_suggestion'>(
    actionId: string | RegExp,
    ...listeners: Middleware<SlackOptionsMiddlewareArgs<Source>>[]
  ): void;
  // TODO: reflect the type in constraits to Source
  public options<Source extends OptionsSource = OptionsSource>(
    constraints: ActionConstraints,
    ...listeners: Middleware<SlackOptionsMiddlewareArgs<Source>>[]
  ): void;
  // TODO: reflect the type in constraits to Source
  public options<Source extends OptionsSource = OptionsSource>(
    actionIdOrConstraints: string | RegExp | ActionConstraints,
    ...listeners: Middleware<SlackOptionsMiddlewareArgs<Source>>[]
  ): void {
    const constraints: ActionConstraints =
      typeof actionIdOrConstraints === 'string' || util.types.isRegExp(actionIdOrConstraints)
        ? { action_id: actionIdOrConstraints }
        : actionIdOrConstraints;

    this.listeners.push([onlyOptions, matchConstraints(constraints), ...listeners] as Middleware<AnyMiddlewareArgs>[]);
  }

  public view<ViewActionType extends SlackViewAction = SlackViewAction>(
    callbackId: string | RegExp,
    ...listeners: Middleware<SlackViewMiddlewareArgs<ViewActionType>>[]
  ): void;
  public view<ViewActionType extends SlackViewAction = SlackViewAction>(
    constraints: ViewConstraints,
    ...listeners: Middleware<SlackViewMiddlewareArgs<ViewActionType>>[]
  ): void;
  public view<ViewActionType extends SlackViewAction = SlackViewAction>(
    callbackIdOrConstraints: string | RegExp | ViewConstraints,
    ...listeners: Middleware<SlackViewMiddlewareArgs<ViewActionType>>[]
  ): void {
    const constraints: ViewConstraints =
      typeof callbackIdOrConstraints === 'string' || util.types.isRegExp(callbackIdOrConstraints)
        ? { callback_id: callbackIdOrConstraints, type: 'view_submission' }
        : callbackIdOrConstraints;
    // Fail early if the constraints contain invalid keys
    const unknownConstraintKeys = Object.keys(constraints).filter((k) => k !== 'callback_id' && k !== 'type');
    if (unknownConstraintKeys.length > 0) {
      this.logger.error(
        `View listener cannot be attached using unknown constraint keys: ${unknownConstraintKeys.join(', ')}`,
      );
      return;
    }

    if (constraints.type !== undefined && !validViewTypes.includes(constraints.type)) {
      this.logger.error(`View listener cannot be attached using unknown view event type: ${constraints.type}`);
      return;
    }

    this.listeners.push([
      onlyViewActions,
      matchConstraints(constraints),
      ...listeners,
    ] as Middleware<AnyMiddlewareArgs>[]);
  }

  public error(errorHandler: ErrorHandler): void {
    this.errorHandler = errorHandler;
  }

  /**
   * Handles events from the receiver
   */
  public async processEvent(event: ReceiverEvent): Promise<void> {
    const { body, ack } = event;

    if (this.developerMode) {
      // log the body of the event
      // this may contain sensitive info like tokens
      this.logger.debug(JSON.stringify(body));
    }

    // TODO: when generating errors (such as in the say utility) it may become useful to capture the current context,
    // or even all of the args, as properties of the error. This would give error handling code some ability to deal
    // with "finally" type error situations.
    // Introspect the body to determine what type of incoming event is being handled, and any channel context
    const { type, conversationId } = getTypeAndConversation(body);
    // If the type could not be determined, warn and exit
    if (type === undefined) {
      this.logger.warn('Could not determine the type of an incoming event. No listeners will be called.');
      return;
    }

    // From this point on, we assume that body is not just a key-value map, but one of the types of bodies we expect
    const bodyArg = body as AnyMiddlewareArgs['body'];

    // Check if type event with the authorizations object or if it has a top level is_enterprise_install property
    const isEnterpriseInstall = isBodyWithTypeEnterpriseInstall(bodyArg, type);
    const source = buildSource(type, conversationId, bodyArg, isEnterpriseInstall);

    let authorizeResult: AuthorizeResult;
    try {
      if (source.isEnterpriseInstall) {
        authorizeResult = await this.authorize(source as AuthorizeSourceData<true>, bodyArg);
      } else {
        authorizeResult = await this.authorize(source as AuthorizeSourceData<false>, bodyArg);
      }
    } catch (error) {
      this.logger.warn('Authorization of incoming event did not succeed. No listeners will be called.');
      error.code = 'slack_bolt_authorization_error';
      return this.handleError(error);
    }

    // Try to set teamId from AuthorizeResult before using one from source
    if (authorizeResult.teamId === undefined && source.teamId !== undefined) {
      authorizeResult.teamId = source.teamId;
    }

    // Try to set enterpriseId from AuthorizeResult before using one from source
    if (authorizeResult.enterpriseId === undefined && source.enterpriseId !== undefined) {
      authorizeResult.enterpriseId = source.enterpriseId;
    }

    const context: Context = { ...authorizeResult };

    // Factory for say() utility
    const createSay = (channelId: string): SayFn => {
      const token = selectToken(context);
      return (message: Parameters<SayFn>[0]) => {
        const postMessageArguments: ChatPostMessageArguments =
          typeof message === 'string'
            ? { token, text: message, channel: channelId }
            : { ...message, token, channel: channelId };

        return this.client.chat.postMessage(postMessageArguments);
      };
    };

    // Set body and payload (this value will eventually conform to AnyMiddlewareArgs)
    // NOTE: the following doesn't work because... distributive?
    // const listenerArgs: Partial<AnyMiddlewareArgs> = {
    const listenerArgs: Pick<AnyMiddlewareArgs, 'body' | 'payload'> & {
      /** Say function might be set below */
      say?: SayFn;
      /** Respond function might be set below */
      respond?: RespondFn;
      /** Ack function might be set below */
      ack?: AckFn<any>;
    } = {
      body: bodyArg,
      payload:
        type === IncomingEventType.Event
          ? (bodyArg as SlackEventMiddlewareArgs['body']).event
          : type === IncomingEventType.ViewAction
          ? (bodyArg as SlackViewMiddlewareArgs['body']).view
          : type === IncomingEventType.Shortcut
          ? (bodyArg as SlackShortcutMiddlewareArgs['body'])
          : type === IncomingEventType.Action &&
            isBlockActionOrInteractiveMessageBody(bodyArg as SlackActionMiddlewareArgs['body'])
          ? (bodyArg as SlackActionMiddlewareArgs<BlockAction | InteractiveMessage>['body']).actions[0]
          : (bodyArg as (
              | Exclude<
                  AnyMiddlewareArgs,
                  SlackEventMiddlewareArgs | SlackActionMiddlewareArgs | SlackViewMiddlewareArgs
                >
              | SlackActionMiddlewareArgs<Exclude<SlackAction, BlockAction | InteractiveMessage>>
            )['body']),
    };

    // Set aliases
    if (type === IncomingEventType.Event) {
      const eventListenerArgs = listenerArgs as SlackEventMiddlewareArgs;
      eventListenerArgs.event = eventListenerArgs.payload;
      if (eventListenerArgs.event.type === 'message') {
        const messageEventListenerArgs = eventListenerArgs as SlackEventMiddlewareArgs<'message'>;
        messageEventListenerArgs.message = messageEventListenerArgs.payload;
      }
    } else if (type === IncomingEventType.Action) {
      const actionListenerArgs = listenerArgs as SlackActionMiddlewareArgs;
      actionListenerArgs.action = actionListenerArgs.payload;
    } else if (type === IncomingEventType.Command) {
      const commandListenerArgs = listenerArgs as SlackCommandMiddlewareArgs;
      commandListenerArgs.command = commandListenerArgs.payload;
    } else if (type === IncomingEventType.Options) {
      const optionListenerArgs = listenerArgs as SlackOptionsMiddlewareArgs<OptionsSource>;
      optionListenerArgs.options = optionListenerArgs.payload;
    } else if (type === IncomingEventType.ViewAction) {
      const viewListenerArgs = listenerArgs as SlackViewMiddlewareArgs;
      viewListenerArgs.view = viewListenerArgs.payload;
    } else if (type === IncomingEventType.Shortcut) {
      const shortcutListenerArgs = listenerArgs as SlackShortcutMiddlewareArgs;
      shortcutListenerArgs.shortcut = shortcutListenerArgs.payload;
    }

    // Set say() utility
    if (conversationId !== undefined && type !== IncomingEventType.Options) {
      listenerArgs.say = createSay(conversationId);
    }

    // Set respond() utility
    if (body.response_url) {
      listenerArgs.respond = buildRespondFn(this.axios, body.response_url);
    } else if (typeof body.response_urls !== 'undefined' && body.response_urls.length > 0) {
      // This can exist only when view_submission payloads - response_url_enabled: true
      listenerArgs.respond = buildRespondFn(this.axios, body.response_urls[0].response_url);
    }

    // Set ack() utility
    if (type !== IncomingEventType.Event) {
      listenerArgs.ack = ack;
    } else {
      // Events API requests are acknowledged right away, since there's no data expected
      await ack();
    }

    // Get the client arg
    let { client } = this;
    const token = selectToken(context);

    if (token !== undefined) {
      let pool;
      const clientOptionsCopy = { ...this.clientOptions };
      if (authorizeResult.teamId !== undefined) {
        pool = this.clients[authorizeResult.teamId];
        if (pool === undefined) {
          // eslint-disable-next-line no-multi-assign
          pool = this.clients[authorizeResult.teamId] = new WebClientPool();
        }
        // Add teamId to clientOptions so it can be automatically added to web-api calls
        clientOptionsCopy.teamId = authorizeResult.teamId;
      } else if (authorizeResult.enterpriseId !== undefined) {
        pool = this.clients[authorizeResult.enterpriseId];
        if (pool === undefined) {
          // eslint-disable-next-line no-multi-assign
          pool = this.clients[authorizeResult.enterpriseId] = new WebClientPool();
        }
      }
      if (pool !== undefined) {
        client = pool.getOrCreate(token, clientOptionsCopy);
      }
    }

    // Dispatch event through the global middleware chain
    try {
      await processMiddleware(
        this.middleware,
        listenerArgs as AnyMiddlewareArgs,
        context,
        client,
        this.logger,
        async () => {
          // Dispatch the event through the listener middleware chains and aggregate their results
          // TODO: change the name of this.middleware and this.listeners to help this make more sense
          const listenerResults = this.listeners.map(async (origListenerMiddleware) => {
            // Copy the array so modifications don't affect the original
            const listenerMiddleware = [...origListenerMiddleware];

            // Don't process the last item in the listenerMiddleware array - it shouldn't get a next fn
            const listener = listenerMiddleware.pop();

            if (listener !== undefined) {
              return processMiddleware(
                listenerMiddleware,
                listenerArgs as AnyMiddlewareArgs,
                context,
                client,
                this.logger,
                async () =>
                  // When the listener middleware chain is done processing, call the listener without a next fn
                  listener({ ...(listenerArgs as AnyMiddlewareArgs), context, client, logger: this.logger }),
              );
            }
          });

          const settledListenerResults = await allSettled(listenerResults);
          const rejectedListenerResults = settledListenerResults.filter(
            (lr) => lr.status === 'rejected',
          ) as allSettled.PromiseRejection<Error>[];
          if (rejectedListenerResults.length === 1) {
            throw rejectedListenerResults[0].reason;
          } else if (rejectedListenerResults.length > 1) {
            throw new MultipleListenerError(rejectedListenerResults.map((rlr) => rlr.reason));
          }
        },
      );
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Global error handler. The final destination for all errors (hopefully).
   */
  private handleError(error: Error): Promise<void> {
    return this.errorHandler(asCodedError(error));
  }
}

// ----------------------------
// For the constructor

const tokenUsage =
  'Apps used in one workspace should be initialized with a token. Apps used in many workspaces ' +
  'should be initialized with oauth installer or authorize.';

function defaultErrorHandler(logger: Logger): ErrorHandler {
  return (error) => {
    logger.error(error);

    return Promise.reject(error);
  };
}

// -----------
// singleAuthorization

function runAuthTestForBotToken(
  client: WebClient,
  authorization: Partial<AuthorizeResult> & { botToken: Required<AuthorizeResult>['botToken'] },
): Promise<{ botUserId: string; botId: string }> {
  // TODO: warn when something needed isn't found
  return authorization.botUserId !== undefined && authorization.botId !== undefined
    ? Promise.resolve({ botUserId: authorization.botUserId, botId: authorization.botId })
    : client.auth.test({ token: authorization.botToken }).then((result) => {
        return {
          botUserId: result.user_id as string,
          botId: result.bot_id as string,
        };
      });
}

// the shortened type, which is supposed to be used only in this source file
type Authorization = Partial<AuthorizeResult> & { botToken: Required<AuthorizeResult>['botToken'] };

async function buildAuthorizeResult(
  isEnterpriseInstall: boolean,
  authTestResult: Promise<{ botUserId: string; botId: string }>,
  authorization: Authorization,
): Promise<AuthorizeResult> {
  return { isEnterpriseInstall, botToken: authorization.botToken, ...(await authTestResult) };
}

function singleAuthorization(
  client: WebClient,
  authorization: Authorization,
  tokenVerificationEnabled: boolean,
): Authorize<boolean> {
  // As Authorize function has a reference to this local variable,
  // this local variable can behave as auth.test call result cache for the function
  let cachedAuthTestResult: Promise<{ botUserId: string; botId: string }>;
  if (tokenVerificationEnabled) {
    // call auth.test immediately
    cachedAuthTestResult = runAuthTestForBotToken(client, authorization);
    return async ({ isEnterpriseInstall }) => {
      return buildAuthorizeResult(isEnterpriseInstall, cachedAuthTestResult, authorization);
    };
  }
  return async ({ isEnterpriseInstall }) => {
    // hold off calling auth.test API until the first access to authorize function
    cachedAuthTestResult = runAuthTestForBotToken(client, authorization);
    return buildAuthorizeResult(isEnterpriseInstall, cachedAuthTestResult, authorization);
  };
}

// ----------------------------
// For processEvent method

/**
 * Helper which builds the data structure the authorize hook uses to provide tokens for the context.
 */
function buildSource<IsEnterpriseInstall extends boolean>(
  type: IncomingEventType,
  channelId: string | undefined,
  body: AnyMiddlewareArgs['body'],
  isEnterpriseInstall: IsEnterpriseInstall,
): AuthorizeSourceData<IsEnterpriseInstall> {
  // NOTE: potentially something that can be optimized, so that each of these conditions isn't evaluated more than once.
  // if this makes it prettier, great! but we should probably check perf before committing to any specific optimization.

  const teamId: string | undefined = (() => {
    if (type === IncomingEventType.Event) {
      const bodyAsEvent = body as SlackEventMiddlewareArgs['body'];
      if (
        Array.isArray(bodyAsEvent.authorizations) &&
        bodyAsEvent.authorizations[0] !== undefined &&
        bodyAsEvent.authorizations[0].team_id !== null
      ) {
        return bodyAsEvent.authorizations[0].team_id;
      }
      return bodyAsEvent.team_id;
    }

    if (type === IncomingEventType.Command) {
      return (body as SlackCommandMiddlewareArgs['body']).team_id;
    }

    if (
      type === IncomingEventType.Action ||
      type === IncomingEventType.Options ||
      type === IncomingEventType.ViewAction ||
      type === IncomingEventType.Shortcut
    ) {
      const bodyAsActionOrOptionsOrViewActionOrShortcut = body as (
        | SlackActionMiddlewareArgs
        | SlackOptionsMiddlewareArgs
        | SlackViewMiddlewareArgs
        | SlackShortcutMiddlewareArgs
      )['body'];

      // When the app is installed using org-wide deployment, team property will be null
      if (
        typeof bodyAsActionOrOptionsOrViewActionOrShortcut.team !== 'undefined' &&
        bodyAsActionOrOptionsOrViewActionOrShortcut.team !== null
      ) {
        return bodyAsActionOrOptionsOrViewActionOrShortcut.team.id;
      }

      // This is the only place where this function might return undefined
      return bodyAsActionOrOptionsOrViewActionOrShortcut.user.team_id;
    }

    return assertNever(type);
  })();

  const enterpriseId: string | undefined = (() => {
    if (type === IncomingEventType.Event) {
      const bodyAsEvent = body as SlackEventMiddlewareArgs['body'];
      if (Array.isArray(bodyAsEvent.authorizations) && bodyAsEvent.authorizations[0] !== undefined) {
        // The enteprise_id here can be null when the workspace is not in an Enterprise Grid
        const theId = bodyAsEvent.authorizations[0].enterprise_id;
        return theId !== null ? theId : undefined;
      }
      return bodyAsEvent.enterprise_id;
    }

    if (type === IncomingEventType.Command) {
      return (body as SlackCommandMiddlewareArgs['body']).enterprise_id;
    }

    if (
      type === IncomingEventType.Action ||
      type === IncomingEventType.Options ||
      type === IncomingEventType.ViewAction ||
      type === IncomingEventType.Shortcut
    ) {
      // NOTE: no type system backed exhaustiveness check within this group of incoming event types
      const bodyAsActionOrOptionsOrViewActionOrShortcut = body as (
        | SlackActionMiddlewareArgs
        | SlackOptionsMiddlewareArgs
        | SlackViewMiddlewareArgs
        | SlackShortcutMiddlewareArgs
      )['body'];

      if (
        typeof bodyAsActionOrOptionsOrViewActionOrShortcut.enterprise !== 'undefined' &&
        bodyAsActionOrOptionsOrViewActionOrShortcut.enterprise !== null
      ) {
        return bodyAsActionOrOptionsOrViewActionOrShortcut.enterprise.id;
      }

      // When the app is installed using org-wide deployment, team property will be null
      if (
        typeof bodyAsActionOrOptionsOrViewActionOrShortcut.team !== 'undefined' &&
        bodyAsActionOrOptionsOrViewActionOrShortcut.team !== null
      ) {
        return bodyAsActionOrOptionsOrViewActionOrShortcut.team.enterprise_id;
      }

      return undefined;
    }

    return assertNever(type);
  })();

  const userId: string | undefined = (() => {
    if (type === IncomingEventType.Event) {
      // NOTE: no type system backed exhaustiveness check within this incoming event type
      const { event } = body as SlackEventMiddlewareArgs['body'];
      if ('user' in event) {
        if (typeof event.user === 'string') {
          return event.user;
        }
        if (typeof event.user === 'object') {
          return event.user.id;
        }
      }
      if ('channel' in event && typeof event.channel !== 'string' && 'creator' in event.channel) {
        return event.channel.creator;
      }
      if ('subteam' in event && event.subteam.created_by !== undefined) {
        return event.subteam.created_by;
      }
      return undefined;
    }

    if (
      type === IncomingEventType.Action ||
      type === IncomingEventType.Options ||
      type === IncomingEventType.ViewAction ||
      type === IncomingEventType.Shortcut
    ) {
      // NOTE: no type system backed exhaustiveness check within this incoming event type
      const bodyAsActionOrOptionsOrViewActionOrShortcut = body as (
        | SlackActionMiddlewareArgs
        | SlackOptionsMiddlewareArgs
        | SlackViewMiddlewareArgs
        | SlackShortcutMiddlewareArgs
      )['body'];
      return bodyAsActionOrOptionsOrViewActionOrShortcut.user.id;
    }

    if (type === IncomingEventType.Command) {
      return (body as SlackCommandMiddlewareArgs['body']).user_id;
    }

    return assertNever(type);
  })();

  return {
    userId,
    isEnterpriseInstall,
    teamId: teamId as IsEnterpriseInstall extends true ? string | undefined : string,
    enterpriseId: enterpriseId as IsEnterpriseInstall extends true ? string : string | undefined,
    conversationId: channelId,
  };
}

function isBodyWithTypeEnterpriseInstall(body: AnyMiddlewareArgs['body'], type: IncomingEventType): boolean {
  if (type === IncomingEventType.Event) {
    const bodyAsEvent = body as SlackEventMiddlewareArgs['body'];
    if (Array.isArray(bodyAsEvent.authorizations) && bodyAsEvent.authorizations[0] !== undefined) {
      return !!bodyAsEvent.authorizations[0].is_enterprise_install;
    }
  }
  // command payloads have this property set as a string
  if (typeof body.is_enterprise_install === 'string') {
    return body.is_enterprise_install === 'true';
  }
  // all remaining types have a boolean property
  if (body.is_enterprise_install !== undefined) {
    return body.is_enterprise_install;
  }
  // as a fallback we assume it's a single team installation (but this should never happen)
  return false;
}

function isBlockActionOrInteractiveMessageBody(
  body: SlackActionMiddlewareArgs['body'],
): body is SlackActionMiddlewareArgs<BlockAction | InteractiveMessage>['body'] {
  return (body as SlackActionMiddlewareArgs<BlockAction | InteractiveMessage>['body']).actions !== undefined;
}

// Returns either a bot token or a user token for client, say()
function selectToken(context: Context): string | undefined {
  return context.botToken !== undefined ? context.botToken : context.userToken;
}

function buildRespondFn(
  axiosInstance: AxiosInstance,
  response_url: string,
): (response: string | RespondArguments) => Promise<AxiosResponse> {
  return async (message: string | RespondArguments) => {
    const normalizedArgs: RespondArguments = typeof message === 'string' ? { text: message } : message;
    return axiosInstance.post(response_url, normalizedArgs);
  };
}

// ----------------------------
// For listener registration methods

const validViewTypes = ['view_closed', 'view_submission'];

// ----------------------------
// Instrumentation
// Don't change the position of the following code
addAppMetadata({ name: packageJson.name, version: packageJson.version });
