import { publisher, makeSubscriber, roomChannel } from './redis.js';

export interface BroadcastMessage {
  id: string;
  roomId: string;
  epoch: string;
  content: string;
  sessionColor?: string;
  createdAt: string;
}

export async function publishMessage(msg: BroadcastMessage): Promise<void> {
  await publisher().publish(roomChannel(msg.roomId), JSON.stringify(msg));
}

/** Async iterator yielding messages published to a room until the signal aborts. */
export async function* roomMessages(roomId: string, signal: AbortSignal): AsyncGenerator<BroadcastMessage> {
  const sub = makeSubscriber();
  const queue: BroadcastMessage[] = [];
  let wake: (() => void) | undefined;

  sub.on('error', (e) => {
    // An unhandled 'error' event on the ioredis EventEmitter would throw; absorb + log.
    console.error('[broadcast] subscriber error', e);
  });
  sub.on('message', (_ch, payload) => {
    let parsed: BroadcastMessage;
    try {
      parsed = JSON.parse(payload) as BroadcastMessage;
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
