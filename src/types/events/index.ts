export * from './base-events';
export {
  MessageEvent as AllMessageEvent,
  BotMessageEvent,
  GenericMessageEvent,
  MessageRepliedEvent,
  MeMessageEvent,
  MessageDeletedEvent,
  ThreadBroadcastMessageEvent,
  MessageChangedEvent,
  EKMAccessDeniedMessageEvent,
} from './message-events';
import { SlackEvent, BasicSlackEvent } from './base-events';
import { StringIndexed } from '../helpers';
import { SayFn } from '../utilities';

/**
 * Arguments which listeners and middleware receive to process an event from Slack's Events API.
 */
export interface SlackEventMiddlewareArgs<EventType extends string = string> {
  payload: EventFromType<EventType>;
  event: this['payload'];
  message: EventType extends 'message' ? this['payload'] : never;
  body: EnvelopedEvent<this['payload']>;
  say: WhenEventHasChannelContext<this['payload'], SayFn>;
}

export interface SlackSubtypedEventMiddlewareArgs<
  EventType extends string = string,
  EventSubtype extends string | undefined = undefined
> {
  payload: EventSubtype extends '*' ? EventFromType<EventType> : EventFromTypeAndSubtype<EventType, EventSubtype>;
  event: this['payload'];
  message: EventType extends 'message' ? this['payload'] : never;
  body: EnvelopedEvent<this['payload']>;
  say: WhenEventHasChannelContext<this['payload'], SayFn>;
}

/**
 * A Slack Events API event wrapped in the standard envelope.
 *
 * This describes the entire JSON-encoded body of a request from Slack's Events API.
 */
interface EnvelopedEvent<Event = BasicSlackEvent> extends StringIndexed {
  token: string;
  team_id: string;
  enterprise_id?: string;
  api_app_id: string;
  event: Event;
  type: 'event_callback';
  event_id: string;
  event_time: number;
  // TODO: the two properties below are being deprecated on Feb 24, 2021
  authed_users?: string[];
  authed_teams?: string[];
  is_ext_shared_channel?: boolean;
  authorizations?: Authorization[];
}

interface Authorization {
  enterprise_id: string | null;
  team_id: string | null;
  user_id: string;
  is_bot: boolean;
  is_enterprise_install?: boolean;
}

/**
 * Type function which given a string `T` returns a type for the matching Slack event(s).
 *
 * When the string matches known event(s) from the `SlackEvent` union, only those types are returned (also as a union).
 * Otherwise, the `BasicSlackEvent<T>` type is returned.
 */
type EventFromType<T extends string> = KnownEventFromType<T> extends never ? BasicSlackEvent<T> : KnownEventFromType<T>;
type EventFromTypeAndSubtype<T extends string, ST extends string | undefined> = KnownEventFromTypeAndSubtype<
  T,
  ST
> extends never
  ? BasicSlackEvent<T>
  : KnownEventFromTypeAndSubtype<T, ST>;
type KnownEventFromType<T extends string> = Extract<SlackEvent, { type: T }>;
type KnownEventFromTypeAndSubtype<T extends string, ST extends string | undefined> = Extract<
  SlackEvent,
  { type: T; subtype: ST }
>;

/**
 * Type function which tests whether or not the given `Event` contains a channel ID context for where the event
 * occurred, and returns `Type` when the test passes. Otherwise this returns `never`.
 */
type WhenEventHasChannelContext<Event, Type> = Event extends { channel: string } | { item: { channel: string } }
  ? Type
  : never;
