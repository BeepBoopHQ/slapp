import { AnyMiddlewareArgs, Receiver, ReceiverEvent } from './types';
import { createServer, Server } from 'http';
import express, { Request, Response, Application, RequestHandler } from 'express';
import rawBody from 'raw-body';
import querystring from 'querystring';
import crypto from 'crypto';
import tsscmp from 'tsscmp';
import App from './App';
import { ReceiverAuthenticityError, ReceiverMultipleAckError } from './errors';
import { Logger, ConsoleLogger } from '@slack/logger';

// TODO: we throw away the key names for endpoints, so maybe we should use this interface. is it better for migrations?
// if that's the reason, let's document that with a comment.
export interface ExpressReceiverOptions {
  signingSecret: string;
  logger?: Logger;
  endpoints?: string | {
    [endpointType: string]: string;
  };
  processBeforeResponse?: boolean;
}

/**
 * Receives HTTP requests with Events, Slash Commands, and Actions
 */
export default class ExpressReceiver implements Receiver {

  /* Express app */
  public app: Application;

  private server: Server;
  private bolt: App | undefined;
  private logger: Logger;
  private processBeforeResponse: boolean;

  constructor({
    signingSecret = '',
    logger = new ConsoleLogger(),
    endpoints = { events: '/slack/events' },
    processBeforeResponse = false,
  }: ExpressReceiverOptions) {
    this.app = express();
    // TODO: what about starting an https server instead of http? what about other options to create the server?
    this.server = createServer(this.app);

    const expressMiddleware: RequestHandler[] = [
      verifySignatureAndParseRawBody(logger, signingSecret),
      respondToSslCheck,
      respondToUrlVerification,
      this.requestHandler.bind(this),
    ];

    this.processBeforeResponse = processBeforeResponse;
    this.logger = logger;
    const endpointList: string[] = typeof endpoints === 'string' ? [endpoints] : Object.values(endpoints);
    for (const endpoint of endpointList) {
      this.app.post(endpoint, ...expressMiddleware);
    }
  }

  private async requestHandler(req: Request, res: Response): Promise<void> {
    let isAcknowledged = false;
    setTimeout(() => {
      if (!isAcknowledged) {
        this.logger.error('An incoming event was not acknowledged within 3 seconds. ' +
            'Ensure that the ack() argument is called in a listener.');
      }
    // tslint:disable-next-line: align
    }, 3001);

    let storedResponse = undefined;
    const event: ReceiverEvent = {
      body: req.body,
      ack: async (response): Promise<void> => {
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
        } else {
          if (!response) {
            res.send('');
          } else if (typeof response === 'string') {
            res.send(response);
          } else {
            res.json(response);
          }
        }
      },
    };

    try {
      await this.bolt?.processEvent(event);

      if (this.processBeforeResponse) {
        let spentMillis = 0;
        const millisForTimeout = 10;
        // Wait here until the isAcknowledged is marked as true or 3 seconds have passed
        while (!isAcknowledged && spentMillis < 3000) {
          await new Promise(resolve => setTimeout(resolve, millisForTimeout));
          spentMillis += millisForTimeout;
        }
        if (isAcknowledged) {
          this.logger.debug(`The listener execution completed in ${spentMillis} millis`);
          if (typeof storedResponse === 'string') {
            res.send(storedResponse);
          }  else {
            res.json(storedResponse);
          }
          this.logger.debug('Acknowledged after the listener completion');
        } // Otherwise, this Bolt app never responds to this request and above setTimeout outputs an error message
      }
    } catch (err) {
      res.send(500);
      throw err;
    }
  }

  public init(bolt: App): void {
    this.bolt = bolt;
  }

  // TODO: the arguments should be defined as the arguments of Server#listen()
  // TODO: the return value should be defined as a type that both http and https servers inherit from, or a union
  public start(port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
      try {
        // TODO: what about other listener options?
        // TODO: what about asynchronous errors? should we attach a handler for this.server.on('error', ...)?
        // if so, how can we check for only errors related to listening, as opposed to later errors?
        this.server.listen(port, () => {
          resolve(this.server);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  // TODO: the arguments should be defined as the arguments to close() (which happen to be none), but for sake of
  // generic types
  public stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      // TODO: what about synchronous errors?
      this.server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

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
  signingSecret: string,
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
      req.body = verifySignatureAndParseBody(signingSecret, stringBody, req.headers);
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
  const logMessage = ('code' in error)
    ? `${message} (code: ${error.code}, message: ${error.message})`
    : `${message} (error: ${error})`;
  logger.warn(logMessage);
}

function verifyRequestSignature(
    signingSecret: string,
    body: string,
    signature: string | undefined,
    requestTimestamp: string | undefined,
): void {
  if (signature === undefined || requestTimestamp === undefined) {
    throw new ReceiverAuthenticityError(
        'Slack request signing verification failed. Some headers are missing.',
    );
  }

  const ts = Number(requestTimestamp);
  if (isNaN(ts)) {
    throw new ReceiverAuthenticityError(
        'Slack request signing verification failed. Timestamp is invalid.',
    );
  }

  // Divide current date to match Slack ts format
  // Subtract 5 minutes from current time
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - (60 * 5);

  if (ts < fiveMinutesAgo) {
    throw new ReceiverAuthenticityError(
        'Slack request signing verification failed. Timestamp is too old.',
    );
  }

  const hmac = crypto.createHmac('sha256', signingSecret);
  const [version, hash] = signature.split('=');
  hmac.update(`${version}:${ts}:${body}`);

  if (!tsscmp(hash, hmac.digest('hex'))) {
    throw new ReceiverAuthenticityError(
        'Slack request signing verification failed. Signature mismatch.',
    );
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

  verifyRequestSignature(
      signingSecret,
      body,
      signature,
      requestTimestamp,
  );

  return parseRequestBody(body, contentType);
}

function parseRequestBody(
    stringBody: string,
    contentType: string | undefined,
): any {
  if (contentType === 'application/x-www-form-urlencoded') {
    const parsedBody = querystring.parse(stringBody);

    if (typeof parsedBody.payload === 'string') {
      return JSON.parse(parsedBody.payload);
    }

    return parsedBody;
  }

  return JSON.parse(stringBody);
}
