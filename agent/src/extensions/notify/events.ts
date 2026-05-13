import { Value } from "typebox/value";
import {
  NotifyActionInvokedEventSchema,
  NotifyActionResponseEventSchema,
  NotifyFailedEventSchema,
  NotifyPublishedEventSchema,
  NotifyPublishPayloadSchema,
  NotifyReceivedEventSchema,
  type NotifyActionInvokedEvent,
  type NotifyActionResponseEvent,
  type NotifyFailedEvent,
  type NotifyPublishedEvent,
  type NotifyPublishPayload,
  type NotifyReceivedEvent,
} from "./types.js";

export function parseNotifyPublishEvent(data: unknown): NotifyPublishPayload | null {
  if (!Value.Check(NotifyPublishPayloadSchema, data)) {
    return null;
  }
  return Value.Parse(NotifyPublishPayloadSchema, data);
}

export function parseNotifyPublishedEvent(data: unknown): NotifyPublishedEvent | null {
  if (!Value.Check(NotifyPublishedEventSchema, data)) {
    return null;
  }
  return Value.Parse(NotifyPublishedEventSchema, data);
}

export function parseNotifyFailedEvent(data: unknown): NotifyFailedEvent | null {
  if (!Value.Check(NotifyFailedEventSchema, data)) {
    return null;
  }
  return Value.Parse(NotifyFailedEventSchema, data);
}

export function parseNotifyReceivedEvent(data: unknown): NotifyReceivedEvent | null {
  if (!Value.Check(NotifyReceivedEventSchema, data)) {
    return null;
  }
  return Value.Parse(NotifyReceivedEventSchema, data);
}

export function parseNotifyActionInvokedEvent(data: unknown): NotifyActionInvokedEvent | null {
  if (!Value.Check(NotifyActionInvokedEventSchema, data)) {
    return null;
  }
  return Value.Parse(NotifyActionInvokedEventSchema, data);
}

export function parseNotifyActionResponseEvent(data: unknown): NotifyActionResponseEvent | null {
  if (!Value.Check(NotifyActionResponseEventSchema, data)) {
    return null;
  }
  return Value.Parse(NotifyActionResponseEventSchema, data);
}
