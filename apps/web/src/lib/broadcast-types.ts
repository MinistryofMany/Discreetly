/**
 * Local mirror of the API's `RoomBroadcast` discriminated union (see
 * `services/api/src/realtime/broadcast.ts`). Mirrored here so the chat UI does
 * not instantiate the AppRouter subscription output type.
 */
export interface ChatBroadcast {
  kind: 'message';
  id: string;
  roomId: string;
  epoch: string;
  content: string;
  sessionColor?: string;
  createdAt: string;
}

export interface SystemBroadcast {
  kind: 'system';
  roomId: string;
  text: string;
  createdAt: string;
}

export type RoomBroadcast = ChatBroadcast | SystemBroadcast;

/** A feed item: a broadcast plus a stable client-side key for React. */
export interface FeedItem {
  key: string;
  broadcast: RoomBroadcast;
}
