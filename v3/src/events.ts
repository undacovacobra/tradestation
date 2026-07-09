import { log } from "./logger.js";
import { notifyPhone } from "./notify.js";
import type { Group } from "./types.js";

export type EventKind = "info" | "trade" | "warn" | "error";

export interface BotEvent {
  id: number;
  time: string; // ISO timestamp
  kind: EventKind;
  message: string; // plain English, shown on the dashboard
  group?: Group;
}

const MAX_EVENTS = 300;
const events: BotEvent[] = [];
let nextId = 1;

/** Record a dashboard-visible event (also mirrored to the console log). */
export function pushEvent(kind: EventKind, message: string, group?: Group): BotEvent {
  const event: BotEvent = { id: nextId++, time: new Date().toISOString(), kind, message, group };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  const line = group ? `[${group}] ${message}` : message;
  if (kind === "error") log.error(line);
  else if (kind === "warn") log.warn(line);
  else if (kind === "trade") log.trade(line);
  else log.info(line);
  // Anything wrong buzzes the phone (if Telegram is configured) — problems
  // should find the user, not wait to be discovered on the dashboard.
  if (kind === "error" || kind === "warn") notifyPhone(`⚠️ ${line}`);
  return event;
}

export function listEvents(limit = 60): BotEvent[] {
  return events.slice(-limit).reverse(); // newest first
}
