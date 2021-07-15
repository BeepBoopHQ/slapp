import { createServer, Server, ServerOptions, RequestListener, IncomingMessage, ServerResponse } from 'http';
import { createServer as createHttpsServer, Server as HTTPSServer, ServerOptions as HTTPSServerOptions } from 'https';
import { ListenOptions } from 'net';
import { parse as qsParse } from 'querystring';
import { Logger, ConsoleLogger, LogLevel } from '@slack/logger';
import { InstallProvider, CallbackOptions, InstallProviderOptions, InstallURLOptions } from '@slack/oauth';
import { URL } from 'url';

import { verify as verifySlackAuthenticity, BufferedIncomingMessage } from './verify-request';
import App from '../App';
import { Receiver, ReceiverEvent } from '../types';
import { renderHtmlForInstallPath } from './render-html-for-install-path';
import {
  ReceiverMultipleAckError,
  ReceiverInconsistentStateError,
  HTTPReceiverDeferredRequestError,
  ErrorCode,
  CodedError,
} from '../errors';

export interface HTTPReceiverOptions {
  signingSecret: string;
  endpoints?: string | string[];
  logger?: Logger;
  logLevel?: LogLevel;
  processBeforeResponse?: boolean;
  clientId?: string;
  clientSecret?: string;
  stateSecret?: InstallProviderOptions['stateSecret']; // required when using default stateStore
  installationStore?: InstallProviderOptions['installationStore']; // default MemoryInstallationStore
  scopes?: InstallURLOptions['scopes'];
  installerOptions?: HTTPReceiverInstallerOptions;
}

export interface HTTPReceiverInstallerOptions {
  installPath?: string;
  redirectUriPath?: string;
  stateStore?: InstallProviderOptions['stateStore']; // default ClearStateStore
  authVersion?: InstallProviderOptions['authVersion']; // default 'v2'
  clientOptions?: InstallProviderOptions['clientOptions'];
  authorizationUrl?: InstallProviderOptions['authorizationUrl'];
  metadata?: InstallURLOptions['metadata'];
  userScopes?: InstallURLOptions['userScopes'];
  callbackOptions?: CallbackOptions;
}

/**
 * Receives HTTP requests with Events, Slash Commands, and Actions
 */
export default class HTTPReceiver implements Receiver {
  private endpoints: string[];

  private signingSecret: string;

  private processBeforeResponse: boolean;

  private app?: App;

  public requestListener: RequestListener;

  private server?: Server;

  public installer?: InstallProvider;

  private installPath?: string; // always defined when installer is defined

  private installRedirectUriPath?: string; // always defined when installer is defined

  private installUrlOptions?: InstallURLOptions; // always defined when installer is defined

  private installCallbackOptions?: CallbackOptions; // always defined when installer is defined

  private logger: Logger;

  constructor({
    signingSecret = '',
    endpoints = ['/slack/events'],
    logger = undefined,
    logLevel = LogLevel.INFO,
    processBeforeResponse = false,
    clientId = undefined,
    clientSecret = undefined,
    stateSecret = undefined,
    installationStore = undefined,
    scopes = undefined,
    installerOptions = {},
  }: HTTPReceiverOptions) {
    // Initialize instance variables, substituting defaults for each value
    this.signingSecret = signingSecret;
    this.processBeforeResponse = processBeforeResponse;
    this.logger =
      logger ??
      (() => {
        const defaultLogger = new ConsoleLogger();
        defaultLogger.setLevel(logLevel);
        return defaultLogger;
      })();
    this.endpoints = Array.isArray(endpoints) ? endpoints : [endpoints];

    // Initialize InstallProvider when it's required options are provided
    if (
      clientId !== undefined &&
      clientSecret !== undefined &&
      (stateSecret !== undefined || installerOptions.stateStore !== undefined)
    ) {
      this.installer = new InstallProvider({
        clientId,
        clientSecret,
        stateSecret,
        installationStore,
        logger,
        logLevel,
        stateStore: installerOptions.stateStore,
        authVersion: installerOptions.authVersion,
        clientOptions: installerOptions.clientOptions,
        authorizationUrl: installerOptions.authorizationUrl,
      });

      // Store the remaining instance variables that are related to using the InstallProvider
      this.installPath = installerOptions.installPath ?? '/slack/install';
      this.installRedirectUriPath = installerOptions.redirectUriPath ?? '/slack/oauth_redirect';
      this.installUrlOptions = {
        scopes: scopes ?? [],
        userScopes: installerOptions.userScopes,
        metadata: installerOptions.metadata,
      };
      this.installCallbackOptions = installerOptions.callbackOptions ?? {};
    }

    // Assign the requestListener property by binding the unboundRequestListener to this instance
    this.requestListener = this.unboundRequestListener.bind(this);
  }

  public init(app: App) {
    this.app = app;
  }

  public start(port: number): Promise<Server>;
  public start(portOrListenOptions: number | ListenOptions, serverOptions?: ServerOptions): Promise<Server>;
  public start(
    portOrListenOptions: number | ListenOptions,
    httpsServerOptions?: HTTPSServerOptions,
  ): Promise<HTTPSServer>;
  public start(
    portOrListenOptions: number | ListenOptions,
    serverOptions: ServerOptions | HTTPSServerOptions = {},
  ): Promise<Server | HTTPSServer> {
    let createServerFn: typeof createServer | typeof createHttpsServer = createServer;

    // Decide which kind of server, HTTP or HTTPS, by searching for any keys in the serverOptions that are exclusive
    // to HTTPS
    if (Object.keys(serverOptions).filter((k) => httpsOptionKeys.includes(k)).length > 0) {
      createServerFn = createHttpsServer;
    }

    if (this.server !== undefined) {
      return Promise.reject(
        new ReceiverInconsistentStateError('The receiver cannot be started because it was already started.'),
      );
    }

    this.server = createServerFn(serverOptions, (req, res) => {
      try {
        this.requestListener(req, res);
      } catch (error) {
        if (error.code === ErrorCode.HTTPReceiverDeferredRequestError) {
          this.logger.info('An unhandled request was ignored');
          res.writeHead(404);
          res.end();
        } else {
          this.logger.error('An unexpected error was encountered');
          this.logger.debug(`Error details: ${error}`);
          res.writeHead(500);
          res.end();
        }
      }
    });

    return new Promise((resolve, reject) => {
      if (this.server === undefined) {
        throw new ReceiverInconsistentStateError(missingServerErrorDescription);
      }

      this.server.on('error', (error) => {
        if (this.server === undefined) {
          throw new ReceiverInconsistentStateError(missingServerErrorDescription);
        }

        this.server.close();

        // If the error event occurs before listening completes (like EADDRINUSE), this works well. However, if the
        // error event happens some after the Promise is already resolved, the error would be silently swallowed up.
        // The documentation doesn't describe any specific errors that can occur after listening has started, so this
        // feels safe.
        reject(error);
      });

      this.server.on('close', () => {
        // Not removing all listeners because consumers could have added their own `close` event listener, and those
        // should be called. If the consumer doesn't dispose of any references to the server properly, this would be
        // a memory leak.
        // this.server?.removeAllListeners();
        this.server = undefined;
      });

      this.server.listen(portOrListenOptions, () => {
        if (this.server === undefined) {
          return reject(new ReceiverInconsistentStateError(missingServerErrorDescription));
        }

        resolve(this.server);
      });
    });
  }

  // TODO: the arguments should be defined as the arguments to close() (which happen to be none), but for sake of
  // generic types
  public stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server === undefined) {
        return reject(new ReceiverInconsistentStateError('The receiver cannot be stopped because it was not started.'));
      }
      this.server.close((error) => {
        if (error !== undefined) {
          return reject(error);
        }

        this.server = undefined;
        resolve();
      });
    });
  }

  private unboundRequestListener(req: IncomingMessage, res: ServerResponse) {
    // Route the request

    // NOTE: the domain and scheme of the following URL object are not necessarily accurate. The URL object is only
    // meant to be used to parse the path and query
    const { pathname: path } = new URL(req.url as string, `http://${req.headers.host}`);
    const method = req.method!.toUpperCase();

    if (this.endpoints.includes(path) && method === 'POST') {
      // Handle incoming ReceiverEvent
      return this.handleIncomingEvent(req, res);
    }

    if (this.installer !== undefined && method === 'GET') {
      // When installer is defined then installPath and installRedirectUriPath are always defined
      const [installPath, installRedirectUriPath] = [this.installPath!, this.installRedirectUriPath!];

      if (path === installPath) {
        // Render installation path (containing Add to Slack button)
        return this.handleInstallPathRequest(res);
      }
      if (path === installRedirectUriPath) {
        // Handle OAuth callback request (to exchange authorization grant for a new access token)
        return this.handleInstallRedirectRequest(req, res);
      }
    }

    // If the request did not match the previous conditions, an error is thrown. The error can be caught by the
    // the caller in order to defer to other routing logic (similar to calling `next()` in connect middleware).
    throw new HTTPReceiverDeferredRequestError('Unhandled HTTP request', req, res);
  }

  private handleIncomingEvent(req: IncomingMessage, res: ServerResponse) {
    // Wrapped in an async closure for ease of using await
    (async () => {
      let bufferedReq: BufferedIncomingMessage;
      let body: any;

      // Verify authenticity
      try {
        bufferedReq = await verifySlackAuthenticity({ signingSecret: this.signingSecret }, req);
      } catch (err) {
        this.logger.warn(`Request verification failed: ${err.message}`);
        res.writeHead(401);
        res.end();
        return;
      }

      // Parse request body
      // The object containing the parsed body is not exposed to the caller. It is preferred to reduce mutations to the
      // req object, so that its as reusable as possible. Later, we should consider adding an option for assigning the
      // parsed body to `req.body`, as this convention has been established by the popular `body-parser` package.
      try {
        body = parseBody(bufferedReq);
      } catch (err) {
        this.logger.warn(`Malformed request body: ${err.message}`);
        res.writeHead(400);
        res.end();
        return;
      }

      // Handle SSL checks
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      if (body.ssl_check) {
        res.writeHead(200);
        res.end();
        return;
      }

      // Handle URL verification
      if (body.type === 'url_verification') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ challenge: body.challenge }));
        return;
      }

      // Setup ack timeout warning
      let isAcknowledged = false;
      setTimeout(() => {
        if (!isAcknowledged) {
          this.logger.error(
            'An incoming event was not acknowledged within 3 seconds. ' +
              'Ensure that the ack() argument is called in a listener.',
          );
        }
      }, 3001);

      // Structure the ReceiverEvent
      let storedResponse;
      const event: ReceiverEvent = {
        body,
        ack: async (response) => {
          this.logger.debug('ack() begin');
          if (isAcknowledged) {
            throw new ReceiverMultipleAckError();
          }
          isAcknowledged = true;
          if (this.processBeforeResponse) {
            // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
            if (!response) {
              storedResponse = '';
            } else {
              storedResponse = response;
            }
            this.logger.debug('ack() response stored');
          } else {
            // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
            if (!response) {
              res.writeHead(200);
              res.end();
            } else if (typeof response === 'string') {
              res.writeHead(200);
              res.end(response);
            } else {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify(response));
            }
            this.logger.debug('ack() response sent');
          }
        },
      };

      // Send the event to the app for processing
      try {
        await this.app?.processEvent(event);
        if (storedResponse !== undefined) {
          if (typeof storedResponse === 'string') {
            res.writeHead(200);
            res.end(storedResponse);
          } else {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(storedResponse));
          }
          this.logger.debug('stored response sent');
        }
      } catch (err) {
        if ('code' in err) {
          // CodedError has code: string
          const errorCode = (err as CodedError).code;
          if (errorCode === ErrorCode.AuthorizationError) {
            // authorize function threw an exception, which means there is no valid installation data
            res.writeHead(401);
            res.end();
            isAcknowledged = true;
            return;
          }
        }
        this.logger.error('An unhandled error occurred while Bolt processed an event');
        this.logger.debug(`Error details: ${err}, storedResponse: ${storedResponse}`);
        res.writeHead(500);
        res.end();
      }
    })();
  }

  private handleInstallPathRequest(res: ServerResponse) {
    // Wrapped in an async closure for ease of using await
    (async () => {
      // NOTE: Skipping some ceremony such as content negotiation, setting informative headers, etc. These may be nice
      // to have for completeness, but there's no clear benefit to adding them, so just keeping things simple. If a
      // user desires a more custom page, they can always call `App.installer.generateInstallUrl()` and render their
      // own page instead of using this one.
      try {
        // This function is only called from within unboundRequestListener after checking that installer is defined, and
        // when installer is defined then installUrlOptions is always defined too.
        const [installer, installUrlOptions] = [this.installer!, this.installUrlOptions!];

        // Generate the URL for the "Add to Slack" button.
        const url = await installer.generateInstallUrl(installUrlOptions);

        // Generate HTML response body
        const body = renderHtmlForInstallPath(url);

        // Serve a basic HTML page including the "Add to Slack" button.
        // Regarding headers:
        // - Content-Type is usually automatically detected by browsers
        // - Content-Length is not used because Transfer-Encoding='chunked' is automatically used.
        res.writeHead(200);
        res.end(body);
      } catch (err) {
        this.logger.error('An unhandled error occurred while Bolt processed a request to the installation path');
        this.logger.debug(`Error details: ${err}`);
      }
    })();
  }

  private handleInstallRedirectRequest(req: IncomingMessage, res: ServerResponse) {
    // This function is only called from within unboundRequestListener after checking that installer is defined, and
    // when installer is defined then installCallbackOptions is always defined too.
    const [installer, installCallbackOptions] = [this.installer!, this.installCallbackOptions!];

    installer.handleCallback(req, res, installCallbackOptions).catch((err) => {
      this.logger.error(
        'HTTPReceiver encountered an unexpected error while handling the OAuth install redirect. Please report to the maintainers.',
      );
      this.logger.debug(`Error details: ${err}`);
    });
  }
}

// Helpers

function parseBody(req: BufferedIncomingMessage) {
  const bodyAsString = req.rawBody.toString();
  const contentType = req.headers['content-type'];
  if (contentType === 'application/x-www-form-urlencoded') {
    const parsedQs = qsParse(bodyAsString);
    const { payload } = parsedQs;
    if (typeof payload === 'string') {
      return JSON.parse(payload);
    }
    return parsedQs;
  }
  return JSON.parse(bodyAsString);
}

// Option keys for tls.createServer() and tls.createSecureContext(), exclusive of those for http.createServer()
const httpsOptionKeys = [
  'ALPNProtocols',
  'clientCertEngine',
  'enableTrace',
  'handshakeTimeout',
  'rejectUnauthorized',
  'requestCert',
  'sessionTimeout',
  'SNICallback',
  'ticketKeys',
  'pskCallback',
  'pskIdentityHint',

  'ca',
  'cert',
  'sigalgs',
  'ciphers',
  'clientCertEngine',
  'crl',
  'dhparam',
  'ecdhCurve',
  'honorCipherOrder',
  'key',
  'privateKeyEngine',
  'privateKeyIdentifier',
  'maxVersion',
  'minVersion',
  'passphrase',
  'pfx',
  'secureOptions',
  'secureProtocol',
  'sessionIdContext',
];

const missingServerErrorDescription =
  'The receiver cannot be started because private state was mutated. Please report this to the maintainers.';
