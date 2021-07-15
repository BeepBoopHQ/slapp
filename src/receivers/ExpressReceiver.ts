/* eslint-disable @typescript-eslint/explicit-member-accessibility, @typescript-eslint/strict-boolean-expressions */

import { createServer, Server, ServerOptions } from 'http';
import { createServer as createHttpsServer, Server as HTTPSServer, ServerOptions as HTTPSServerOptions } from 'https';
import { ListenOptions } from 'net';
import express, { Request, Response, Application, RequestHandler, Router } from 'express';
import rawBody from 'raw-body';
import querystring from 'querystring';
import crypto from 'crypto';
import tsscmp from 'tsscmp';
import { Logger, ConsoleLogger, LogLevel } from '@slack/logger';
import { InstallProvider, CallbackOptions, InstallProviderOptions, InstallURLOptions } from '@slack/oauth';
import App from '../App';
import {
  ReceiverAuthenticityError,
  ReceiverMultipleAckError,
  ReceiverInconsistentStateError,
  ErrorCode,
  CodedError,
} from '../errors';
import { AnyMiddlewareArgs, Receiver, ReceiverEvent } from '../types';
import { renderHtmlForInstallPath } from './render-html-for-install-path';

// TODO: we throw away the key names for endpoints, so maybe we should use this interface. is it better for migrations?
// if that's the reason, let's document that with a comment.
export interface ExpressReceiverOptions {
  signingSecret: string | (() => PromiseLike<string>);
  logger?: Logger;
  logLevel?: LogLevel;
  endpoints?:
    | string
    | {
        [endpointType: string]: string;
      };
  processBeforeResponse?: boolean;
  clientId?: string;
  clientSecret?: string;
  stateSecret?: InstallProviderOptions['stateSecret']; // required when using default stateStore
  installationStore?: InstallProviderOptions['installationStore']; // default MemoryInstallationStore
  scopes?: InstallURLOptions['scopes'];
  installerOptions?: InstallerOptions;
}

// Additional Installer Options
interface InstallerOptions {
  stateStore?: InstallProviderOptions['stateStore']; // default ClearStateStore
  authVersion?: InstallProviderOptions['authVersion']; // default 'v2'
  metadata?: InstallURLOptions['metadata'];
  installPath?: string;
  redirectUriPath?: string;
  callbackOptions?: CallbackOptions;
  userScopes?: InstallURLOptions['userScopes'];
  clientOptions?: InstallProviderOptions['clientOptions'];
  authorizationUrl?: InstallProviderOptions['authorizationUrl'];
}

/**
 * Receives HTTP requests with Events, Slash Commands, and Actions
 */
export default class ExpressReceiver implements Receiver {
  /* Express app */
  public app: Application;

  private server?: Server;

  private bolt: App | undefined;

  private logger: Logger;

  private processBeforeResponse: boolean;

  public router: Router;

  public installer: InstallProvider | undefined = undefined;

  constructor({
    signingSecret = '',
    logger = undefined,
    logLevel = LogLevel.INFO,
    endpoints = { events: '/slack/events' },
    processBeforeResponse = false,
    clientId = undefined,
    clientSecret = undefined,
    stateSecret = undefined,
    installationStore = undefined,
    scopes = undefined,
    installerOptions = {},
  }: ExpressReceiverOptions) {
    this.app = express();

    if (typeof logger !== 'undefined') {
      this.logger = logger;
    } else {
      this.logger = new ConsoleLogger();
      this.logger.setLevel(logLevel);
    }

    if (typeof logger !== 'undefined') {
      this.logger = logger;
    } else {
      this.logger = new ConsoleLogger();
      this.logger.setLevel(logLevel);
    }

    const expressMiddleware: RequestHandler[] = [
      verifySignatureAndParseRawBody(this.logger, signingSecret),
      respondToSslCheck,
      respondToUrlVerification,
      this.requestHandler.bind(this),
    ];

    this.processBeforeResponse = processBeforeResponse;

    const endpointList = typeof endpoints === 'string' ? [endpoints] : Object.values(endpoints);
    this.router = Router();
    endpointList.forEach((endpoint) => {
      this.router.post(endpoint, ...expressMiddleware);
    });

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
        logLevel,
        logger, // pass logger that was passed in constructor, not one created locally
        stateStore: installerOptions.stateStore,
        authVersion: installerOptions.authVersion!,
        clientOptions: installerOptions.clientOptions,
        authorizationUrl: installerOptions.authorizationUrl,
      });
    }

    // Add OAuth routes to receiver
    if (this.installer !== undefined) {
      const redirectUriPath =
        installerOptions.redirectUriPath === undefined ? '/slack/oauth_redirect' : installerOptions.redirectUriPath;
      this.router.use(redirectUriPath, async (req, res) => {
        await this.installer!.handleCallback(req, res, installerOptions.callbackOptions);
      });

      const installPath = installerOptions.installPath === undefined ? '/slack/install' : installerOptions.installPath;
      this.router.get(installPath, async (_req, res, next) => {
        try {
          const url = await this.installer!.generateInstallUrl({
            metadata: installerOptions.metadata,
            scopes: scopes!,
            userScopes: installerOptions.userScopes,
          });
          res.send(renderHtmlForInstallPath(url));
        } catch (error) {
          next(error);
        }
      });
    }

    this.app.use(this.router);
  }

  private async requestHandler(req: Request, res: Response): Promise<void> {
    let isAcknowledged = false;
    setTimeout(() => {
      if (!isAcknowledged) {
        this.logger.error(
          'An incoming event was not acknowledged within 3 seconds. Ensure that the ack() argument is called in a listener.',
        );
      }
      // tslint:disable-next-line: align
    }, 3001);

    let storedResponse;
    const event: ReceiverEvent = {
      body: req.body,
      ack: async (response): Promise<void> => {
        this.logger.debug('ack() begin');
        if (isAcknowledged) {
          throw new ReceiverMultipleAckError();
        }
        isAcknowledged = true;
        if (this.processBeforeResponse) {
          if (!response) {
            storedResponse = '';
          } else {
            storedResponse = response;
          }
          this.logger.debug('ack() response stored');
        } else {
          if (!response) {
            res.send('');
          } else if (typeof response === 'string') {
            res.send(response);
          } else {
            res.json(response);
          }
          this.logger.debug('ack() response sent');
        }
      },
    };

    try {
      await this.bolt?.processEvent(event);
      if (storedResponse !== undefined) {
        if (typeof storedResponse === 'string') {
          res.send(storedResponse);
        } else {
          res.json(storedResponse);
        }
        this.logger.debug('stored response sent');
      }
    } catch (err) {
      if ('code' in err) {
        // CodedError has code: string
        const errorCode = (err as CodedError).code;
        if (errorCode === ErrorCode.AuthorizationError) {
          // authorize function threw an exception, which means there is no valid installation data
          res.status(401).send();
          isAcknowledged = true;
          return;
        }
      }
      res.status(500).send();
      throw err;
    }
  }

  public init(bolt: App): void {
    this.bolt = bolt;
  }

  // TODO: can this method be defined as generic instead of using overloads?
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

    // Decide which kind of server, HTTP or HTTPS, by search for any keys in the serverOptions that are exclusive to HTTPS
    if (Object.keys(serverOptions).filter((k) => httpsOptionKeys.includes(k)).length > 0) {
      createServerFn = createHttpsServer;
    }

    if (this.server !== undefined) {
      return Promise.reject(
        new ReceiverInconsistentStateError('The receiver cannot be started because it was already started.'),
      );
    }

    this.server = createServerFn(serverOptions, this.app);

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
}

export const respondToSslCheck: RequestHandler = (req, res, next) => {
  if (req.body && req.body.ssl_check) {
    res.send();
    return;
  }
  next();
};

export const respondToUrlVerification: RequestHandler = (req, res, next) => {
  if (req.body && req.body.type && req.body.type === 'url_verification') {
    res.json({ challenge: req.body.challenge });
    return;
  }
  next();
};

/**
 * This request handler has two responsibilities:
 * - Verify the request signature
 * - Parse request.body and assign the successfully parsed object to it.
 */
export function verifySignatureAndParseRawBody(
  logger: Logger,
  signingSecret: string | (() => PromiseLike<string>),
): RequestHandler {
  return async (req, res, next) => {
    let stringBody: string;
    // On some environments like GCP (Google Cloud Platform),
    // req.body can be pre-parsed and be passed as req.rawBody here
    const preparsedRawBody: any = (req as any).rawBody;
    if (preparsedRawBody !== undefined) {
      stringBody = preparsedRawBody.toString();
    } else {
      stringBody = (await rawBody(req)).toString();
    }

    // *** Parsing body ***
    // As the verification passed, parse the body as an object and assign it to req.body
    // Following middlewares can expect `req.body` is already a parsed one.

    try {
      // This handler parses `req.body` or `req.rawBody`(on Google Could Platform)
      // and overwrites `req.body` with the parsed JS object.
      req.body = verifySignatureAndParseBody(
        typeof signingSecret === 'string' ? signingSecret : await signingSecret(),
        stringBody,
        req.headers,
      );
    } catch (error) {
      if (error) {
        if (error instanceof ReceiverAuthenticityError) {
          logError(logger, 'Request verification failed', error);
          return res.status(401).send();
        }

        logError(logger, 'Parsing request body failed', error);
        return res.status(400).send();
      }
    }

    return next();
  };
}

function logError(logger: Logger, message: string, error: any): void {
  const logMessage =
    'code' in error ? `${message} (code: ${error.code}, message: ${error.message})` : `${message} (error: ${error})`;
  logger.warn(logMessage);
}

function verifyRequestSignature(
  signingSecret: string,
  body: string,
  signature: string | undefined,
  requestTimestamp: string | undefined,
): void {
  if (signature === undefined || requestTimestamp === undefined) {
    throw new ReceiverAuthenticityError('Slack request signing verification failed. Some headers are missing.');
  }

  const ts = Number(requestTimestamp);
  // eslint-disable-next-line no-restricted-globals
  if (isNaN(ts)) {
    throw new ReceiverAuthenticityError('Slack request signing verification failed. Timestamp is invalid.');
  }

  // Divide current date to match Slack ts format
  // Subtract 5 minutes from current time
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;

  if (ts < fiveMinutesAgo) {
    throw new ReceiverAuthenticityError('Slack request signing verification failed. Timestamp is too old.');
  }

  const hmac = crypto.createHmac('sha256', signingSecret);
  const [version, hash] = signature.split('=');
  hmac.update(`${version}:${ts}:${body}`);

  if (!tsscmp(hash, hmac.digest('hex'))) {
    throw new ReceiverAuthenticityError('Slack request signing verification failed. Signature mismatch.');
  }
}

/**
 * This request handler has two responsibilities:
 * - Verify the request signature
 * - Parse request.body and assign the successfully parsed object to it.
 */
function verifySignatureAndParseBody(
  signingSecret: string,
  body: string,
  headers: Record<string, any>,
): AnyMiddlewareArgs['body'] {
  // *** Request verification ***
  const {
    'x-slack-signature': signature,
    'x-slack-request-timestamp': requestTimestamp,
    'content-type': contentType,
  } = headers;

  verifyRequestSignature(signingSecret, body, signature, requestTimestamp);

  return parseRequestBody(body, contentType);
}

function parseRequestBody(stringBody: string, contentType: string | undefined): any {
  if (contentType === 'application/x-www-form-urlencoded') {
    const parsedBody = querystring.parse(stringBody);

    if (typeof parsedBody.payload === 'string') {
      return JSON.parse(parsedBody.payload);
    }

    return parsedBody;
  }

  return JSON.parse(stringBody);
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
