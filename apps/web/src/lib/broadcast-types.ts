/**
 * Subscription broadcast types consumed by the web client. Re-exported from
 * `@discreetly/api` (which re-exports from `services/api/src/realtime/broadcast.ts`)
 * so a shape change in the API source breaks these imports instead of drifting
 * silently. The `message.subscribe` subscription yields `RoomBroadcast` directly;
 * `inferRouterOutputs` does not cover subscription yield types, so a direct
 * re-export is the right anchor.
 */
export type {
  RoomBroadcast,
  ChatBroadcast,
  SystemBroadcast,
  TombstoneBroadcast,
} from '@discreetly/api';

/**
 * In-place marker rendered for an operator-tombstoned message. Kept as a local
 * literal (not re-exported from `@discreetly/api`) so the client bundle does not
 * pull the server entry's Node-only runtime (ioredis) graph. Must match the
 * server's `TOMBSTONE_MARKER` (realtime/broadcast.ts); the shared
 * `ChatBroadcast`/`TombstoneBroadcast` types above keep the contract aligned.
 */
export const TOMBSTONE_MARKER = 'removed by operator';

/** A feed item: a broadcast plus a stable client-side key for React. */
export interface FeedItem {
  key: string;
  broadcast: import('@discreetly/api').RoomBroadcast;
}
