import { publisher, makeSubscriber, roomChannel } from './redis.js';

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

/** The chat message payload without its `kind` tag (added by `publishMessage`). */
export type BroadcastMessage = Omit<ChatBroadcast, 'kind'>;

export async function publishMessage(msg: BroadcastMessage): Promise<void> {
  await publisher().publish(roomChannel(msg.roomId), JSON.stringify({ kind: 'message', ...msg }));
}

export async function publishSystem(
  roomId: string,
  text: string,
  createdAt: string,
): Promise<void> {
  await publisher().publish(
    roomChannel(roomId),
    JSON.stringify({ kind: 'system', roomId, text, createdAt }),
  );
}

/** Async iterator yielding messages published to a room until the signal aborts. */
export async function* roomMessages(
  roomId: string,
  signal: AbortSignal,
): AsyncGenerator<RoomBroadcast> {
  const sub = makeSubscriber();
  const queue: RoomBroadcast[] = [];
  let wake: (() => void) | undefined;

  sub.on('error', (e) => {
    // An unhandled 'error' event on the ioredis EventEmitter would throw; absorb + log.
    console.error('[broadcast] subscriber error', e);
  });
  sub.on('message', (_ch, payload) => {
    let parsed: RoomBroadcast;
    try {
      parsed = JSON.parse(payload) as RoomBroadcast;
    } catch (e) {
      console.error('[broadcast] dropping malformed payload', e);
      return;
    }
    queue.push(parsed);
    wake?.();
  });

  // Exactly ONE abort listener for the whole subscription (waking the current sleep).
  const onAbort = (): void => wake?.();
  signal.addEventListener('abort', onAbort, { once: true });

  await sub.subscribe(roomChannel(roomId));
  try {
    while (!signal.aborted) {
      while (queue.length) yield queue.shift()!;
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      await sub.quit();
    } catch {
      sub.disconnect();
    }
  }
}
