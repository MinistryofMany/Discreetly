/**
 * Subscription broadcast types consumed by the web client. Re-exported from
 * `@discreetly/api` (which re-exports from `services/api/src/realtime/broadcast.ts`)
 * so a shape change in the API source breaks these imports instead of drifting
 * silently. The `message.subscribe` subscription yields `RoomBroadcast` directly;
 * `inferRouterOutputs` does not cover subscription yield types, so a direct
 * re-export is the right anchor.
 */
export type { RoomBroadcast, ChatBroadcast, SystemBroadcast } from '@discreetly/api';

/** A feed item: a broadcast plus a stable client-side key for React. */
export interface FeedItem {
  key: string;
  broadcast: import('@discreetly/api').RoomBroadcast;
}
